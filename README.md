# GTM TEMPLATE : GOOGLE CONSENT MODE

Use this Google Tag Manager template to load <a href="https://iabeurope.eu/transparency-consent-framework/" target="_blank">TCF</a> compliant Google Consent Mode and optionnaly Sirdata CMP.

Please read our documentation <a href="https://cmp.docs.sirdata.net/v/en/script-management/google-consent-mode" target="_blank">here</a>.

Open CMP account at <a href="https://cmp.sirdata.io/" target="_blank">here</a>.

## Meta and OpenAI consent command ownership

The first template group can override who owns consent commands for Meta and OpenAI on the
current page. Compatibility is designed for the official templates only:

- [Meta Pixel](https://github.com/facebook/GoogleTagManager-WebTemplate-For-FacebookPixel)
- [OpenAI Ads Measurement Pixel](https://github.com/openai/ads-measurement-pixel-gtm-template)

Each selector has three states:

| Value | Behaviour |
|---|---|
| **Inherit CMP configuration** | Leaves the public override property absent, so the CMP configuration remains authoritative. |
| **Enabled** | Publishes `true` before the CMP loader runs, prepares the vendor queue, and sends updates from this GTM template. |
| **Disabled** | Publishes `false`; this template neither installs a vendor queue nor sends vendor updates. |

When enabled, run this template on **Consent Initialization**, before the official vendor tags.
For OpenAI, `oaiq.q` and `oaiq.queue` are unified and only competing `consent` commands are
replaced; `init`, `measure`, Pixel ID, and user-data commands keep their order. For Meta, the
same rule preserves `_fbq`, `fbq.queue`, `fbq.push`, `init`, `track`, Pixel ID, and user data.

Sandboxed `copyFromWindow` does not expose queue identity. The template therefore never treats
matching serialized content as proof that two queue paths are aliases. It probes shared global
storage with a synchronous, immediately removed sentinel. If shared storage cannot be proven,
both queue sources are preserved — even when their pending commands have identical content —
because dropping a legitimate command is less safe than retaining both source invocations.

The GDPR/US regime is not available synchronously when Consent Initialization starts. Meta
therefore reuses a valid stored `m` bit when one exists and otherwise queues a temporary
`consent revoke`. Once the CMP callback identifies the regime, GDPR receives `consent grant` or
`consent revoke`; the US path removes that temporary queued signal and uses
`dataProcessingOptions` according to the US opt-out. If the SDK already received the temporary
revoke, it is neutralized before the US data-processing option is sent. A Meta consent revoke is
**not** equivalent to Limited Data Use, and is not documented or treated as such.

These controls coordinate commands only. This template does not inject the Meta or OpenAI SDK,
does not prevent another tag from downloading either SDK, and does not promise network
blocking. Custom HTML snippets and third-party templates are not guaranteed to use the
compatible queue shapes.

## Before submitting a change

The `___TESTS___` section of `template.tpl` only runs inside the GTM template editor, and in
practice it only reaches the `default` path — the `__sdcmpapi` listener, update deduplication,
segmented `__sdgcm` replay, and vendor queue ownership are not fully covered by it. Run the
standalone harness as well:

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
