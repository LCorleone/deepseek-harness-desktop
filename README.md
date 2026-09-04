Machine branch written by the Company catalog publish workflow.

Each successful non-dry-run run mirrors its signed pair plus the
packed tarballs to <run-id>/catalog-manifest.json +
<run-id>/publish-meta.json + <run-id>/packages/*.tgz (the
company-catalog-signed artifact stays the authoritative channel).
Only the newest run directories are kept; older ones are pruned.
Integrity never depends on this transport: publish-local re-runs the
sha256 + signature + sequence-ratchet checks on these bytes, and the
tarball bytes against the signed integrity.
