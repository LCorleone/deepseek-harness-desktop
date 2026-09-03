// The whole fixture plugin: a few lines of JS, no dependencies, no native
// builds — just enough for pack-tarball to produce a real npm-pack artifact
// and the reference measure install to hash a real tree.
'use strict'

const greeting = 'hello from the tarball channel'

module.exports = {
  greeting,
  greet() {
    return greeting
  },
}
