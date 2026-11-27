# Security

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/evanl666/keel/security/advisories/new), not in public issues.
We aim to reply within three working days.

In scope: the server, worker, runner, Helm chart and Docker image in this repository. Of particular interest:
leaks of restricted or confidential notes, ways around trust levels or approvals, the runner executing anything
outside its local allow-list, and tenant or label bypasses in the API.

Keel is self-hosted. You are responsible for TLS, network policy, secret storage and database backups in your
deployment; `keel doctor` checks the basics.
