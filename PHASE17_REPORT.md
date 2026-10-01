# Phase 17 Status: PARTIAL

## Objective

Converge the public product identity on **枝序 · ZhiXu**, prepare `v1.0.0-rc.1`, and require a clean qualification run from the exact release-candidate SHA before publication.

## Candidate identity

- Product: `枝序 · ZhiXu`
- Package: `@anysoft/zhixu`
- Version: `1.0.0-rc.1`
- Repository: `https://github.com/anysoft/ZhiXu`
- Container contract: `/data` volume with `DATA_DIR=/data/state`

Public application, package, OCI, Compose, Kubernetes, documentation, security, issue-template, notification and release metadata surfaces now use the ZhiXu identity. A static CI gate rejects retired product names and repository URLs on current release surfaces.

Historical refactor records, architecture decisions, internal compatibility keys, database contracts, environment variables, and third-party dependency identities are intentionally outside the public-brand rewrite. Their stability remains part of data and protocol compatibility.

## Gates

- Phase 16B qualified baseline (`505c0bac`): PASS
- Phase 17 local static/type/front-end/back-end/release-gate validation: PASS
- Phase 17 Kubernetes manifest structure validation: PASS
- Phase 17 GitNexus change-scope review: PASS (MEDIUM; public identity and notification presentation paths)
- Phase 17 hosted Linux CI Foundation: PENDING
- Phase 17 hosted Container Qualification: PENDING
- Exact-SHA RC approval: PENDING

## Publication

- Candidate commit: this report is committed with the Phase 17 source candidate
- Push: starts the hosted qualification gates for the exact candidate SHA
- Tag: NOT PERFORMED
- Multi-architecture image publication: NOT PERFORMED
- GitHub Release: NOT PERFORMED

`ZHIXU_V1_0_0_RC_1_RELEASED=NO`
