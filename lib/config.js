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
        return {hash, filePath, fileName}
      })

      // Normalize the rest.
      site.skip = site.skip || []
      site.replace = site.replace || []
      site.auth = site.auth || null
    }

    // console.log(JSON.stringify(this, null, 2))
  }

  skip (siteHostname, url) {
    for (let site of this._getFilteredSites(siteHostname)) {
      if (site.skip.some(pattern => url.match(pattern))) {
        return true
      }
    }

    return false
  }

  getReplacements (siteHostname) {
    let replacements = []
    for (let site of this._getFilteredSites(siteHostname)) {
      replacements = replacements.concat(site.replace)
    }

    return replacements
  }

  getInjects (siteHostname) {
    let injects = []
    for (let site of this._getFilteredSites(siteHostname)) {
      injects = injects.concat(site.inject)
    }

    return injects
  }

  getAuth (siteHostname) {
    for (let site of this._getFilteredSites(siteHostname)) {
      if (site.auth) {
        return site.auth
      }
    }

    return null
  }

  getInject (hash) {
    for (let site of this.sites) {
      for (let inject of site.inject) {
        if (inject.hash === hash) {
          return inject.filePath
        }
      }
    }

    return null
  }

  _getFilteredSites (siteHostname) {
    return this.sites.filter(site => site.urls.some(pattern => siteHostname.match(pattern)))
  }
}

module.exports = Config
