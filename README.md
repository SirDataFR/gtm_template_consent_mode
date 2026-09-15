# GTM TEMPLATE : GOOGLE CONSENT MODE

Use this Google Tag Manager template to load <a href="https://iabeurope.eu/transparency-consent-framework/" target="_blank">TCF</a> compliant Google Consent Mode and optionnaly Sirdata CMP.

Please read our documentation <a href="https://cmp.docs.sirdata.net/v/en/script-management/google-consent-mode" target="_blank">here</a>.

Open CMP account at <a href="https://cmp.sirdata.io/" target="_blank">here</a>.

## Meta and OpenAI defaults with CMP-owned updates

The first template group carries one checkbox per vendor for the official
[Meta Pixel](https://github.com/facebook/GoogleTagManager-WebTemplate-For-FacebookPixel) and
[OpenAI Ads Measurement Pixel](https://github.com/openai/ads-measurement-pixel-gtm-template)
templates. Checked publishes `true` and prepares that vendor's default and queue before those tags
run; unchecked publishes `false` and sends no consent command for it at all. The served CMP remains
the only producer of later Google, Meta, and OpenAI updates.

There is no third "inherit the CMP configuration" state, and its absence is deliberate rather than
a simplification. This tag runs before any CMP script, so it cannot read that configuration; and it
is itself the one preparing these defaults, so something has to say whether to prepare them. A
value left unpublished would hand that question to a script that has not loaded yet.

When Google Consent Mode is enabled and at least one default-settings row is emitted, the template
publishes `ABconsentCMP.gtmGoogleConsentModeDefaultSet=true` before that first default. The served
CMP can therefore skip its legacy fallback default while remaining responsible for every update.
An empty settings table emits neither a Google default nor this handoff marker.

Both vendors start from the same rule: the prepared default is negative unless stored state says
otherwise, and a stored privacy objection wins over it. OpenAI reuses the persisted `o` bit when
valid; Meta reuses the persisted `m` bit the same way. Each default is explicitly marked, so the CMP
can recognise its own provisional entry.

The Meta reading is deliberately one-way — a positive bit raises the default to a grant, a negative
one never lowers it further. The stored Meta bit does not mean the same thing under both regimes: a
consent under GDPR, the absence of an objection under the US one. Only the first calls for a
`revoke`, which pauses the pixel outright, where a US objection limits data use and keeps it
sending. Reading the bit symmetrically would therefore pause the pixel for a returning US visitor
who objected, costing them their whole measurement instead of limiting it.

If a vendor SDK is already initialized, the template sends that default directly without replacing
the function or its queues; otherwise the queues are unified while non-consent commands retain their
order. The CMP controller can remove or neutralize only the marked entry, without deleting publisher
consent commands.

When CMP loading is configured, the template installs same-window mini-stubs only for missing CMP
APIs so synchronous callers can queue work. It then still loads the real `/stub` before `/cmp`.
The real stub is mandatory: it canonicalises those marked mini-stubs, preserves their queues/events,
and adds iframe locators, `postMessage` bridges, and IE11 bundle selection. The template creates no
locator iframe or message listener itself. The first-party loader and its regular-host fallback are
preserved.

These controls do not inject a vendor SDK or prevent another tag from downloading one. Custom HTML
and third-party templates are not guaranteed to use the compatible queue shapes.

## The US regulation scope is not set here

This tag never acts on it. It cannot know the visitor's state, and nothing it prepares depends on
the answer, so a setting here would have been a pure pass-through whose only effect was to override
the CMP from a page that had no opinion — and an unchecked box would then have silently narrowed a
scope the publisher had widened. The scope belongs where the jurisdiction is known, which is the CMP
configuration.

## Before submitting a change

The `___TESTS___` section of `template.tpl` only runs inside the GTM template editor, and in
practice it only reaches the Google `default` path. The same-window mini-stubs, loader ordering,
cookie-deletion listener, and vendor defaults are covered by the standalone harness instead:

```sh
node tests/sandbox-harness.js
```

It extracts the sandboxed JS straight out of `template.tpl` and replays it against fake GTM
APIs. It needs nothing but `node` — no dependencies, no install step. CI runs exactly this
command on Node 20 and 22 for every push to `main` and every pull request. A static guard also
rejects `try`/`catch` and the bare `arguments` object in the sandboxed section; use named
parameters or documented template APIs such as `createArgumentsQueue` instead.

It is **not** Google's sandbox: it checks behaviour and these explicit syntax exclusions, not
permissions or the complete restricted JavaScript subset. **Those still have to be validated in
the template editor before publishing**, and no amount of green CI replaces that step.

Publishing is a separate manual act: append the merged commit's sha to `versions` in
`metadata.yaml` with its `changeNotes`. The gallery updates the template **in place**, and each
publisher accepts it in their container at their own pace — so a version you stop supporting
keeps running in the wild for a long time. Decoders are written to tolerate older formats for
that reason.
