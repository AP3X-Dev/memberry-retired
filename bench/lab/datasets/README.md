# Dataset acquisition

Acquisition is network-off by default:

```powershell
npm run bench:lab:dataset:acquire -- --dataset <id> --source-file <download>
npm run bench:lab:dataset:acquire -- --dataset <id> --network
```

Both paths enforce the same registry policy before publishing an artifact into
the cache. Downloads are staged, hashed, size-checked when a size is registered,
and renamed only after verification. A checksum mismatch removes the partial
file and fails the command. The default cache is under `node_modules/.cache`, so
large public benchmark data cannot be committed accidentally.

The `--network` flag is explicit. CI never uses it.

LongMemEval-S Cleaned and LoCoMo must remain blocked until the `CMP-006A` source,
license, privacy, revision, size, and SHA-256 requirements in
[../ROADMAP.md](../ROADMAP.md) are complete. Acquisition success alone does not
authorize dataset use or make a benchmark report releasable.
