# How to Contribute

We'd love to accept your patches and contributions to this project. There are
just a few small guidelines you need to follow.

## Contributor License Agreement

Contributions to this project must be accompanied by a Contributor License
Agreement. You (or your employer) retain the copyright to your contribution;
this simply gives us permission to use and redistribute your contributions as
part of the project.

You generally only need to submit a CLA once, so if you've already submitted one
(even if it was for a different project), you probably don't need to do it
again.

## Code reviews

All submissions, including submissions by project members, require review. We
use GitHub pull requests for this purpose. Consult
[GitHub Help](https://help.github.com/articles/about-pull-requests/) for more
information on using pull requests.

## Before submitting a change

The `___TESTS___` section of `template.tpl` only runs inside the GTM template editor, and in
practice it only reaches the Google `default` path. The same-window mini-stub, loader ordering,
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

## Community Guidelines

This project follows
[Google's Open Source Community Guidelines](https://opensource.google.com/conduct/).
