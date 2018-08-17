'use strict'

const express = require('express')
const expressProxy = require('express-http-proxy')
const http = require('http')
const https = require('https')
const url = require('url')
const fs = require('fs')

const STATIC = '/__static/'

// Serously, this should be the default.
process.on('unhandledRejection', reason => console.error(reason))

class Proxy {
  constructor (config) {
    this.cfg = config
  }

  serve () {
    const app = express()
    app.port = this.cfg.port
    http
      .createServer(app)
      .listen(this.cfg.port, this.cfg.hostname, () => {
        console.log(`listening at ${this.cfg.hostname}:${this.cfg.port}`)
      })

    const secureApp = express()
    secureApp.port = this.cfg.securePort
    https
      .createServer({key: this.cfg.key, cert: this.cfg.cert}, secureApp)
      .listen(this.cfg.securePort, this.cfg.hostname, () => {
        console.log(`listening at ${this.cfg.hostname}:${this.cfg.securePort} (secure)`)
      })

    return [app, secureApp]
  }

  start () {
    const apps = this.serve()
    for (const app of apps) {
      app
        .use(this.basicAuth.bind(this))
        .use(STATIC + ':hash/:fileName', this.static.bind(this))
        .use(this.proxy.bind(this))
    }
  }

  static (req, res, next) {
    const filePath = this.cfg.getInject(req.params.hash, req.params.fileName)
    if (filePath) {
      return res.sendFile(filePath)
    }

    next()
  }

  proxy (req, res, next) {
    const currentPort = req.app.port
    const remoteHostname = this.getRemoteHostname(req)
    const remoteUrl = remoteHostname + req.originalUrl
    const remoteOrigin = currentPort === this.cfg.securePort ? 'https://' + remoteHostname : 'http://' + remoteHostname
    const skip = this.cfg.skip(remoteUrl, remoteUrl)

    const proxyArgs = {
      proxyReqPathResolver: req => {
        return req.url
      },
      // filter: req => {
      //   return !remoteUrl.endsWith('.woff2')
      // },
      proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
        let auth = this.cfg.getAuth(remoteUrl)
        if (auth) {
          auth = Buffer.from(auth).toString('base64')
          proxyReqOpts.headers['Authorization'] = `Basic ${auth}`
        }

        return proxyReqOpts
      }
    }

    if (skip) {
      console.error('Streaming:', remoteUrl)
    } else {
      proxyArgs.userResDecorator = (proxyRes, proxyResData, userReq, userRes) => {
        // Handle redirects.
        const location = userRes.getHeader('location')
        if (location) {
          const u = url.parse(location)
          u.search = u.search || ''
          const newLocation = u.protocol === 'https:'
            ? `${u.protocol}//${u.hostname}.${this.cfg.hostname}:${this.cfg.securePort}${u.pathname}${u.search}`
            : `${u.protocol}//${u.hostname}.${this.cfg.hostname}:${this.cfg.port}${u.pathname}${u.search}`

          if (!this.cfg.skip(remoteUrl, newLocation)) {
            console.log(`Redirect: ${location} -> ${newLocation}`)
            userRes.setHeader('location', newLocation)
          }

          return proxyResData
        }

        // Process URLs.
        const type = userRes.getHeader('content-type')
        if (type.includes('html') || type.includes('css') || type.includes('javascript') || type.includes('json')) {
          let responseText = proxyResData.toString()
          // console.log(`Processing response: ${userRes.req.url}`)
          responseText = this.updateUrls(remoteUrl, responseText, currentPort)
          responseText = this.replaceContent(remoteUrl, responseText)

          if (type.includes('html')) {
            responseText = this.inject(remoteUrl, responseText)
          }

          return responseText
        }

        return proxyResData
      }
    }

    const proxy = expressProxy(remoteOrigin, proxyArgs)
    proxy(req, res, next)
  }

  updateUrls (remoteUrl, responseText, currentPort) {
    // http://example.com -> http://example.com.localhost:8080
    // https://example.com -> https://example.com.localhost:8443
    // //example.com -> //example.com.localhost:CURRENT
    // http:\/\/example.com -> http:\/\/example.com.localhost:8080
    // https:\/\/example.com -> https:\/\/example.com.localhost:8443
    // \/\/example.com -> \/\/example.com.localhost:CURRENT
    // return responseText.replace(/(http:|https:|)(\\?\/\\?\/[a-z]+[a-z0-9-]+\.[a-z0-9-.]+)((.*?)(["|']))/g, (match, g1, g2, g3, g4) => {

    return responseText.replace(/(http:|https:|)(\\?\/\\?\/[a-z]+[a-z0-9-]+\.[a-z0-9-.]+)((.*?)(["|']))/g, (match, g1, g2, g3, g4) => {
      // if (gx) {
        // console.log('Funky:', match)
        // return match
      // }
      if (this.cfg.skip(remoteUrl, match)) {
        console.log('Passing through:', `${g1}${g2}${g4}`)
        return match
      }

      if (g1 === 'https:') {
        return `${g1}${g2}.${this.cfg.hostname}:${this.cfg.securePort}${g3}`
      } else if (g1 === 'http:') {
        return `${g1}${g2}.${this.cfg.hostname}:${this.cfg.port}${g3}`
      } else if (g1 === '') {
        return `${g1}${g2}.${this.cfg.hostname}:${currentPort}${g3}`
      }

      return match
    })
  }

  replaceContent (remoteUrl, responseText) {
    for (let entry of this.cfg.getReplacements(remoteUrl)) {
      responseText = responseText.replace(new RegExp(entry.search, 'g'), entry.replace)
    }
    return responseText
  }

  inject (remoteUrl, responseText) {
    // Get inject HTML.
    const injects = []
    for (let inject of this.cfg.getInjects(remoteUrl)) {
      inject.fileName.endsWith('.js') && injects.push(`<script src="${STATIC}${inject.hash}/${inject.fileName}"></script>`)
      inject.fileName.endsWith('.css') && injects.push(`<link rel="stylesheet" href="${STATIC}${inject.hash}/${inject.fileName}" />`)
      inject.fileName.endsWith('.html') && fs.existsSync(inject.filePath) && injects.push(fs.readFileSync(inject.filePath, 'utf8'))
    }
    const injectHtml = injects.join('\n')

    // Inject HTML right after <body> (if present).
    // Regex explanation:
    // Start with '<body'
    // If no space, match '>'
    // If space, match everything except '>' until '>'.
    const tag = /<body(\s+[^>]*)?>/.exec(responseText)
    if (!tag || !tag.length) {
      console.error('Unable to find <body> tag.')
      return injectHtml + responseText
    }

    // Inject the entry.
    return responseText.replace(tag[0], tag[0] + injectHtml)
  }

  basicAuth (req, res, next) {
    if (!this.cfg.auth) {
      return next()
    }

    const b64auth = (req.headers.authorization || '').split(' ').pop()
    const provided = Buffer.from(b64auth, 'base64').toString()
    if (this.cfg.auth === provided) {
      return next() // Access granted.
    }

    res.set('WWW-Authenticate', 'Basic realm="401"')
    res.status(401).send('Access denied.')
  }

  getRemoteHostname (req) {
    return req.hostname.slice(0, -(this.cfg.hostname.length + 1))
  }
}

module.exports = Proxy
