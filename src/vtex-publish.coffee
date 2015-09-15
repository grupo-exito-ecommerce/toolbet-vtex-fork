Q = require 'q'
pkg = require '../package.json'
metadata = require './lib/meta'
publisher = require './lib/publish'
auth = require './lib/auth'
chalk = require 'chalk'

Q.all([
  auth.getValidCredentials()
  metadata.getAppMetadata()
]).spread((credentials, meta) ->
  name = meta.name
  version = meta.version
  vendor = meta.vendor

  publisher.publish(name, version, vendor, credentials)
).then((app) ->
  console.log chalk.green("\nApp "+chalk.italic(app.app)+" version "+chalk.bold(app.version)+" was successfully published!")
).catch((error) ->
  errorMsg = JSON.parse(error.body).message or error
  console.error "\nFailed to publish app".red
  console.error errorMsg.bold.red
)
