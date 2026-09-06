# GTM TEMPLATE : GOOGLE CONSENT MODE

Use this Google Tag Manager template to load <a href="https://iabeurope.eu/transparency-consent-framework/" target="_blank">TCF</a> compliant Google Consent Mode and optionnaly Sirdata CMP.

Please read our documentation <a href="https://cmp.docs.sirdata.net/v/en/script-management/google-consent-mode" target="_blank">here</a>.

Open CMP account at <a href="https://cmp.sirdata.io/" target="_blank">here</a>.

## Before submitting a change

The `___TESTS___` section of `template.tpl` only runs inside the GTM template editor, and in
practice it only reaches the `default` path — the `__sdcmpapi` listener, the update
deduplication and the `__sdgcm` cookie write are not covered by it. Run the standalone harness
as well:

```sh
node tests/sandbox-harness.js
```

It extracts the sandboxed JS straight out of `template.tpl` and replays it against fake GTM
APIs. It needs nothing but `node` — no dependencies, no install step. CI runs exactly this
command on Node 20 and 22 for every push to `main` and every pull request.

It is **not** Google's sandbox: it checks behaviour, not permissions nor the restrictions of
the JS subset. **Those still have to be validated in the template editor before publishing**,
and no amount of green CI replaces that step.

Publishing is a separate manual act: append the merged commit's sha to `versions` in
`metadata.yaml` with its `changeNotes`. The gallery updates the template **in place**, and each
publisher accepts it in their container at their own pace — so a version you stop supporting
keeps running in the wild for a long time. Decoders are written to tolerate older formats for
that reason.
