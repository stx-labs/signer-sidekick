# Notices

Signer Sidekick contains source material derived from `stacks-network/stacks-core`, pinned to
the exact version and hashes recorded in `contracts/PROVENANCE.md`. The upstream project is
licensed under GPL-3.0.

The regtest lifecycle harness also contains pinned source from the canonical
`stacks-sbtc/sbtc` contracts. Those sources, their deployed identifiers, and their exact hashes
are recorded in `contracts/PROVENANCE.md`; the upstream repository is GPL-3.0 licensed.

The `design/` directory contains Stacks Labs design-system guidance, tokens, and font files.
Matter and Matter Mono redistribution for this project has been confirmed by Stacks Labs.
Instrument Sans and Open Sauce Sans are distributed under the SIL Open Font License 1.1; their
copyright notices and the license text are included in `design/fonts/OFL-1.1.txt`.

For every published container image, the release build must pass the signed Git commit as
`--build-arg VCS_REF=<commit>`. The image tag and resulting OCI revision label identify the exact
commit containing its corresponding source. Release notes must link that signed commit and include
the repository URL so recipients can obtain the complete source for the image under GPL-3.0.
