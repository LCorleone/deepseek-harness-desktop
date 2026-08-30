Machine branch written by the Company catalog publish workflow.

Each successful non-dry-run run mirrors its signed pair to
<run-id>/catalog-manifest.json + <run-id>/publish-meta.json (the
company-catalog-signed artifact stays the authoritative channel).
Only the newest run directories are kept; older ones are pruned.
Integrity never depends on this transport: publish-local re-runs the
sha256 + signature + sequence-ratchet checks on these bytes.
