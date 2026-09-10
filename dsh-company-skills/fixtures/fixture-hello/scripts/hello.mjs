// Fixture script: the packer only needs to see that the bundle-relative
// asset reference below resolves inside the bundle.
const NOTES_PATH = 'assets/notes.md'

process.stdout.write(`fixture-hello would read ${NOTES_PATH}\n`)
