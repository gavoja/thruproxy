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
    const remoteOrigin = currentPort === this.cfg.securePort ? 'https://' + remoteHostname : 'http://' + remoteHostname

    const proxy = expressProxy(remoteOrigin, {
      proxyReqPathResolver: req => {
        return req.url
      },
      proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
        let auth = this.cfg.getAuth(remoteHostname)
        if (auth) {
          auth = Buffer.from(auth).toString('base64')
          proxyReqOpts.headers['Authorization'] = `Basic ${auth}`
        }

        return proxyReqOpts
      },
      userResDecorator: (proxyRes, proxyResData, userReq, userRes) => {
        // Handle redirects.
        const location = userRes.getHeader('location')
        if (location) {
          const u = url.parse(location)
          u.search = u.search || ''
          const newLocation = u.protocol === 'https:'
            ? `${u.protocol}//${u.hostname}.${this.cfg.hostname}:${this.cfg.securePort}${u.pathname}${u.search}`
            : `${u.protocol}//${u.hostname}.${this.cfg.hostname}:${this.cfg.port}${u.pathname}${u.search}`

          if (!this.cfg.skip(remoteHostname, newLocation)) {
            console.log(`Redirect: ${location} -> ${newLocation}`)
            userRes.setHeader('location', newLocation)
          }

          return proxyResData
        }

        // Process URLs.
        let responseText = proxyResData.toString()
        const type = userRes.getHeader('content-type')
        if (type.includes('html') || type.includes('css') || type.includes('javascript') || type.includes('json')) {
          // console.log(`Processing response: ${userRes.req.url}`)
          responseText = this.updateUrls(remoteHostname, responseText, currentPort)
          responseText = this.replaceContent(remoteHostname, responseText)

          if (type.includes('html')) {
            responseText = this.inject(remoteHostname, responseText)
          }

          return responseText
        }

        return proxyResData
      }
    })

    proxy(req, res, next)
  }

  updateUrls (remoteHostname, responseText, currentPort) {
    // http://example.com -> http://example.com.localhost:8080
    // https://example.com -> https://example.com.localhost:8443
    // //example.com -> //example.com.localhost:CURRENT
    // http:\/\/example.com -> http:\/\/example.com.localhost:8080
    // https:\/\/example.com -> https:\/\/example.com.localhost:8443
    // \/\/example.com -> \/\/example.com.localhost:CURRENT
    return responseText.replace(/(http:|https:|)(\\?\/\\?\/[a-z]+[a-z0-9-]+\.[a-z0-9-.]+)/g, (match, g1, g2) => {
      if (this.cfg.skip(remoteHostname, match)) {
        return match
      }

      if (g1 === 'https:') {
        return `${match}.${this.cfg.hostname}:${this.cfg.securePort}`
      } else if (g1 === 'http:') {
        return `${match}.${this.cfg.hostname}:${this.cfg.port}`
      } else if (g1 === '') {
        return `${match}.${this.cfg.hostname}:${currentPort}`
      }

      return match
    })
  }

  replaceContent (remoteHostname, responseText) {
    for (let entry of this.cfg.getReplacements(remoteHostname)) {
      responseText = responseText.replace(new RegExp(entry.search, 'g'), entry.replace)
    }
    return responseText
  }

  inject (remoteHostname, responseText) {
    // Get inject HTML.
    const injects = []
    for (let inject of this.cfg.getInjects(remoteHostname)) {
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
