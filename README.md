# GTM TEMPLATE : GOOGLE CONSENT MODE

Use this Google Tag Manager template to load <a href="https://iabeurope.eu/transparency-consent-framework/" target="_blank">TCF</a> compliant Google Consent Mode together with the Sirdata CMP.

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

When Google Consent Mode is enabled the template publishes
`ABconsentCMP.gtmGoogleConsentModeDefaultSet=true` before its first default. The served CMP can
therefore skip its legacy fallback default while remaining responsible for every update. Switching
Google Consent Mode off emits neither a Google default nor this handoff marker.

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

A function already on the page is never replaced, for either vendor. Where Meta's has to be created,
it is created the way their own tag template creates it: it reads `fbq.callMethod` on every call and
hands the call to the SDK as soon as that exists, falling back to the pending list until then. That
routing is the contract their SDK expects — it attaches `callMethod` to whatever function the page
already has rather than replacing it — so a function that only ever appends would never reach it,
and a consent signal sent after the SDK had loaded would queue up behind the events it was meant to
release. OpenAI's SDK replaces its own function at startup, so a plain pending list is enough there.

## A measurement is kept out of the list the OpenAI pixel drains

The OpenAI pixel **drops** a measurement it receives while consent is denied. It does not hold it,
it does not queue it, and it never replays it — its own startup reads the pending list, applies the
consent state it finds first, and throws away everything the state refuses. Anything handed to it
before the visitor has answered is therefore lost for good rather than delayed, which is the
opposite of how the other vendors behave.

So while the stored default is a refusal, `measure` and `measureSingle` are parked on
`ABconsentCMP.openai.preQueue` instead of the pending list, and every other command still goes to
the pending list unchanged. The consent script replays what it finds there once consent is granted.
Under a stored grant nothing is held back: the pixel accepts measurements then, and holding them
would delay what already works.

This is the only place that can still do it. On a real page the pixel replaces its own function
about 765 ms before the consent script lands, so the script cannot capture what it never saw — and
by then the measurement is not reachable from the page at all. Both halves are needed: holding
without the replay keeps the measurement parked forever, and the replay without the holding has
nothing to replay.

Two ordering constraints hold it together. The list is created before the function that fills it,
and it is created empty rather than replaced, so a page that published one first does not lose what
it holds. And the namespace must not be written wholesale after the page starts pushing into that
list — today every such write happens inside the same synchronous run, before the vendor tag fires.

## No publisher queue method is ever executed

OpenAI keeps two names for its pending-command list — `oaiq.q` for the page snippet, `oaiq.queue`
for their own tag template — and a publisher who installed the pixel both ways genuinely has two,
each holding real commands. The template therefore has to know whether the two names are one list
before deciding to read both, or it either duplicates every pending command or loses a set.

It answers that with a named property written on one name and read back through the other, then
cleared. Nothing of the publisher's runs, so a replaced queue method cannot throw into the template
— which matters because this sandbox has no way to contain such an exception. The mark never
becomes an entry either, so `length` does not move and no SDK can drain it as a command, whatever
happens next. The property is read by its own path: `copyFromWindow` hands back a copy of an array,
and a copy does not carry non-index properties.

Meta needs no such question. `_fbq` is Meta's own alias of `fbq` — their page snippet sets it, their
tag template aliases it — so a distinct `_fbq.queue` belongs to another advertiser's pixel rather
than to a second copy of this one's pending work. Only the canonical `fbq.queue` is read, and that
other pixel's commands are no longer merged in.

Once the partner and configuration identifiers are set, the template installs same-window
mini-stubs only for missing CMP APIs so synchronous callers can queue work, then asks for the CMP
bundle directly. The request that used to go in front of it existed to prepare the page — the early
command queues and the consent defaults — and this tag now does both itself, so that request would
be a round trip spent re-doing work already done on this page. The bundle takes the marked
mini-stubs over, preserving their queues and events, and adds the iframe locators, `postMessage`
bridges and legacy-bundle selection. The template creates no locator iframe or message listener
itself. The request carries `tms=gtm`, which names the tag manager that prepared the page, so the
served script is told rather than left to infer it. The first-party loader and its regular-host
fallback are preserved.

These controls do not inject a vendor SDK or prevent another tag from downloading one. Custom HTML
and third-party templates are not guaranteed to use the compatible queue shapes.

## The default consent state is automatic, and the CMP is not optional

The template sets the Google Consent Mode default state on its own, and that is the nominal path:
every signal starts denied, then a returning visitor's recorded choice is replayed from the stored
container before the page runs, a privacy signal short-circuits the whole chain to a denial, and on
the US perimeter silence is treated as a refusal rather than as agreement. Nothing has to be
configured for any of that.

Publishers who need their own regional defaults check a single box, which reveals the same
per-country rules as before and replaces the automatic state with them — a recorded choice still
takes precedence over whatever they declare. The box starts unchecked and the rules are stored under
a new name, so a container upgraded from an earlier version moves to the automatic state instead of
replaying rules nobody reviewed.

Loading the CMP is no longer a choice either: the partner and configuration identifiers are required
fields. This tag only ever prepares defaults that the CMP is then responsible for resolving, and it
installs mini-stub queues the CMP is responsible for taking over. Skipping the load left both
half-done — defaults posted with nobody to update them, queues with nobody to drain them.

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
parameters or documented template APIs such as `createArgumentsQueue` instead. It reads the code
with comments stripped, so a comment may name a construct in order to explain why it is avoided.

It is **not** Google's sandbox: it checks behaviour and these explicit syntax exclusions, not
permissions or the complete restricted JavaScript subset. **Those still have to be validated in
the template editor before publishing**, and no amount of green CI replaces that step.

Publishing is a separate manual act: append the merged commit's sha to `versions` in
`metadata.yaml` with its `changeNotes`. The gallery updates the template **in place**, and each
publisher accepts it in their container at their own pace — so a version you stop supporting
keeps running in the wild for a long time. Decoders are written to tolerate older formats for
that reason.
