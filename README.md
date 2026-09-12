# GTM TEMPLATE : GOOGLE CONSENT MODE

Use this Google Tag Manager template to load <a href="https://iabeurope.eu/transparency-consent-framework/" target="_blank">TCF</a> compliant Google Consent Mode and optionnaly Sirdata CMP.

Please read our documentation <a href="https://cmp.docs.sirdata.net/v/en/script-management/google-consent-mode" target="_blank">here</a>.

Open CMP account at <a href="https://cmp.sirdata.io/" target="_blank">here</a>.

## Meta and OpenAI defaults with CMP-owned updates

The first template group keeps tri-state overrides for the official
[Meta Pixel](https://github.com/facebook/GoogleTagManager-WebTemplate-For-FacebookPixel) and
[OpenAI Ads Measurement Pixel](https://github.com/openai/ads-measurement-pixel-gtm-template)
templates. **Enabled** publishes the activation override and prepares the vendor default/file
before those tags run. The served CMP remains the only producer of later Google, Meta, and OpenAI
updates. **Disabled** publishes `false`; **Inherit** leaves the CMP configuration authoritative.

When Google Consent Mode is enabled and at least one default-settings row is emitted, the template
publishes `ABconsentCMP.gtmGoogleConsentModeDefaultSet=true` before that first default. The served
CMP can therefore skip its legacy fallback default while remaining responsible for every update.
An empty settings table emits neither a Google default nor this handoff marker.

OpenAI reuses the persisted `o` bit when valid, otherwise defaults to `false`. If its SDK is already
initialized, the template sends that default directly without replacing the function or either queue;
otherwise its `q` and `queue` files are unified while non-consent commands retain their order. Meta
starts with a conservative, explicitly marked temporary revoke because the GDPR/US regime is not yet
known. An initialized Meta SDK receives it directly without replacing `fbq`, `_fbq`, or their queues.
The CMP controller can remove or neutralize only that marked entry before applying GDPR consent or US
data-processing options, without deleting publisher consent commands.

When CMP loading is configured, the template installs same-window mini-stubs only for missing CMP
APIs so synchronous callers can queue work. It then still loads the real `/stub` before `/cmp`.
The real stub is mandatory: it canonicalises those marked mini-stubs, preserves their queues/events,
and adds iframe locators, `postMessage` bridges, and IE11 bundle selection. The template creates no
locator iframe or message listener itself. The first-party loader and its regular-host fallback are
preserved.

These controls do not inject a vendor SDK or prevent another tag from downloading one. Custom HTML
and third-party templates are not guaranteed to use the compatible queue shapes.

## Before submitting a change

The `___TESTS___` section of `template.tpl` only runs inside the GTM template editor, and in
practice it only reaches the Google `default` path. The same-window mini-stubs, loader ordering,
cookie-deletion listener, and vendor defaults are covered by the standalone harness instead:

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
