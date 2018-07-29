'use strict'

const Config = require('./lib/config')
const Proxy = require('./lib/proxy')

function main () {
  const configPath = process.argv.length === 3 ? process.argv[2] : null
  const proxy = new Proxy(new Config(configPath))
  proxy.start()
}

main()
