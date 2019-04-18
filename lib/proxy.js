'use strict'

const express = require('express')
const expressProxy = require('express-http-proxy')
const http = require('http')
const https = require('https')
const url = require('url')
const fs = require('fs')
const chalk = require('chalk')

const STATIC = '/__static/'
const STREAM = ['.png', '.jpeg', '.jpg', '.gif', '.woff', '.woff2']

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
      .createServer({ key: this.cfg.key, cert: this.cfg.cert }, secureApp)
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

    // Redirect back to original file.
    if (skip) {
      console.log(chalk.red('✘'), remoteUrl)
      const protocol = req.secure ? 'https://' : 'http://'
      return res.redirect(protocol + remoteUrl)
    }

    const proxyArgs = {
      proxyReqPathResolver: req => {
        return req.url
      },
      proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
        let auth = this.cfg.getAuth(remoteUrl)
        if (auth) {
          auth = Buffer.from(auth).toString('base64')
          proxyReqOpts.headers['authorization'] = `Basic ${auth}`
        }

        // Accept only gzip encoding.
        proxyReqOpts.headers['accept-encoding'] = 'gzip'
        return proxyReqOpts
      }
    }

    // Defining userResDecorator disables streaming.
    // It should only be enabled for specific extensions only or if any query param is set.
    if (STREAM.some(ending => req.path.toLowerCase().endsWith(ending))) {
      console.log(chalk.blue('✔'), remoteUrl)
    } else {
      console.log(chalk.green('✔'), remoteUrl)
      proxyArgs.userResDecorator = (proxyRes, proxyResData, userReq, userRes) => {
        this.fixCookieDomains(userRes, remoteHostname)

        // Handle redirects.
        const location = userRes.getHeader('location')
        if (location) {
          const u = url.parse(location)
          u.search = u.search || ''
          const newLocation = u.protocol === 'https:'
            ? `${u.protocol}//${u.hostname}.${this.cfg.hostname}:${this.cfg.securePort}${u.pathname}${u.search}`
            : `${u.protocol}//${u.hostname}.${this.cfg.hostname}:${this.cfg.port}${u.pathname}${u.search}`

          if (!this.cfg.skip(remoteUrl, newLocation)) {
            console.log(chalk.green('  ✔'), `${location} -> ${newLocation}`)
            userRes.setHeader('location', newLocation)
          }

          return proxyResData
        }

        // Process URLs.
        const type = userRes.getHeader('content-type')
        if (type.includes('html') || type.includes('css') || type.includes('javascript') || type.includes('json')) {
          let responseText = proxyResData.toString('utf8')
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

  fixCookieDomains (res, remoteHostname) {
    const cookies = res.getHeader('set-cookie') || []
    const fixedCookies = cookies.map(cookie => cookie.replace(remoteHostname, `${remoteHostname}.${this.cfg.hostname}`))
    res.setHeader('set-cookie', fixedCookies)
  }

  updateUrls (remoteUrl, responseText, currentPort) {
    // http://example.com -> http://example.com.localhost:8080
    // https://example.com -> https://example.com.localhost:8443
    // //example.com -> //example.com.localhost:CURRENT
    // http:\/\/example.com -> http:\/\/example.com.localhost:8080
    // https:\/\/example.com -> https:\/\/example.com.localhost:8443
    // \/\/example.com -> \/\/example.com.localhost:CURRENT
    // .example.com ->
    return responseText.replace(/(http:|https:)?(\\?\/\\?\/)([a-z]+[a-z0-9-]+\.[a-z0-9-.]+)((.*?)(\s*["|']))/g, (match, protocol = '', slashes, hostname, rest, path) => {
      const foundUrl = protocol + slashes + hostname + path

      if (this.cfg.skip(remoteUrl, foundUrl)) {
        // console.log(chalk.red('  ✘'), match)
        return match
      }

      // console.log(chalk.green('  ✔'), foundUrl)
      const port = (protocol === 'http:' || protocol === '') ? `:${this.cfg.port}` : `:${this.cfg.securePort}`
      const hostnameSuffix = `.${this.cfg.hostname}`
      const updatedUrl = protocol + slashes + hostname + hostnameSuffix + port + rest

      return updatedUrl
    })
  }

  replaceContent (remoteUrl, responseText) {
    for (let entry of this.cfg.getReplacements(remoteUrl)) {
      responseText = responseText.replace(new RegExp(entry.search, 'g'), entry.replace)
    }
    return responseText
  }

  inject (remoteUrl, responseText) {
    // Inject HTML right after <body> (if present).
    // Regex explanation:
    // Start with '<body'
    // If no space, match '>'
    // If space, match everything except '>' until '>'.
    const tag = /<body(\s+[^>]*)?>/.exec(responseText)
    if (!tag || !tag.length) {
      // No body found, just add at the begining.
      console.log('  No body tag found.')
      return responseText
      // return injectHtml + responseText
    }

    // Get inject HTML.
    const injects = this.cfg.getInjects(remoteUrl)
    const htmlInjects = []
    for (let inject of injects) {
      console.log(chalk.green('  ►'), inject.fileName)
      inject.fileName.endsWith('.js') && htmlInjects.push(`<script src="${STATIC}${inject.hash}/${inject.fileName}"></script>`)
      inject.fileName.endsWith('.css') && htmlInjects.push(`<link rel="stylesheet" href="${STATIC}${inject.hash}/${inject.fileName}" />`)
      inject.fileName.endsWith('.html') && fs.existsSync(inject.filePath) && htmlInjects.push(fs.readFileSync(inject.filePath, 'utf8'))
    }
    const injectHtml = htmlInjects.join('\n')

    // Inject the entry right before </body>.
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
