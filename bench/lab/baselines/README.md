# Protected baseline

`memberry-7a31231.json` records the last deployed control before evaluation-lab
development: source commit, configuration, datasets, normalized source hashes,
commands, and measured quality results. `baseline.lock.json` protects the whole
manifest using canonical JSON SHA-256.

`npm run bench:lab:baseline:verify` reads benchmark source directly from the
recorded Git commit and verifies every artifact. It does not compare the files
in the working tree, so candidate development cannot silently redefine the
control.

`npm run bench:lab:ci` then:

1. validates registries and required dataset bytes;
2. verifies the immutable baseline and lock;
3. reruns the deterministic legacy quality control;
4. rejects any metric regression or missing result;
5. compares the new proxy against an independent control across the lab corpus;
6. writes an immutable, secret-redacted run artifact under
   `node_modules/.cache/memberry-lab/runs`.

No network, credentials, Redis, or Neo4j are required for this PR gate.
