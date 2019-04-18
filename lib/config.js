'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DATA = {
  port: 8080,
  securePort: 8443,
  hostname: 'localhost',
  sites: []
}

class Config {
  constructor (configPath = null) {
    if (!configPath) {
      this.data = DATA
      return
    }

    configPath = path.resolve(process.cwd(), configPath)
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    Object.assign(this, data)

    // Load key and cert.
    const configDir = path.dirname(configPath)
    this.key = fs.readFileSync(path.resolve(configDir, this.key), 'utf8')
    this.cert = fs.readFileSync(path.resolve(configDir, this.cert), 'utf8')

    for (let site of this.sites) {
      // Make injects relative to the config file and calculate hash.
      site.inject = (site.inject || []).map(inject => {
        const filePath = path.resolve(configDir, inject)
        const fileName = path.basename(filePath)
        const hash = crypto.createHash('md5').update(filePath).digest('hex')
        return { hash, filePath, fileName }
      })

      // Normalize the rest.
      site.skip = (site.skip || []).map(pattern => new RegExp(pattern, 'gm'))
      site.replace = site.replace || []
      site.auth = site.auth || null
    }

    // console.log(JSON.stringify(this, null, 2))
  }

  skip (siteUrl, urlToSkip) {
    for (let site of this._getFilteredSites(siteUrl)) {
      for (let pattern of site.skip) {
        if (urlToSkip.match(pattern)) {
          return true
        }
      }
    }

    return false
  }

  getReplacements (siteUrl) {
    let replacements = []
    for (let site of this._getFilteredSites(siteUrl)) {
      replacements = replacements.concat(site.replace)
    }

    return replacements
  }

  getInjects (siteUrl) {
    let injects = []
    for (let site of this._getFilteredSites(siteUrl)) {
      injects = injects.concat(site.inject)
    }

    return injects
  }

  getAuth (siteUrl) {
    for (let site of this._getFilteredSites(siteUrl)) {
      if (site.auth) {
        return site.auth
      }
    }

    return null
  }

  getInject (hash, fileName) {
    for (let site of this.sites) {
      for (let inject of site.inject) {
        if (inject.hash === hash) {
          // Add support for source maps.
          return fileName.endsWith('.map') ? inject.filePath + '.map' : inject.filePath
        }
      }
    }

    return null
  }

  _getFilteredSites (siteUrl) {
    return this.sites.filter(site => site.urls.some(pattern => siteUrl.match(pattern)))
  }
}

module.exports = Config
