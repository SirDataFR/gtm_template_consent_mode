// Behaviour harness for this template's sandboxed JS.
//
// WHY it exists: the `___TESTS___` section of the .tpl only runs inside the GTM template editor,
// and in practice it reaches little beyond the `default` path -- the `onUserChoice` listener and
// update deduplication escape it. This file is what covers the rest, and CI runs it on every push.
//
//     node tests/sandbox-harness.js
//
// It extracts the JS from the .tpl and replays it against fake GTM APIs. This is NOT Google's
// sandbox: it checks neither the permissions nor the restrictions of the JS subset. It checks
// behaviour, which nothing else here does.
const path = require("path");
const fs = require("fs");

const TPL = fs.readFileSync(path.join(__dirname, "..", "template.tpl"), "utf8");

// Extraction is the ONE place where this harness could lie silently: if a delimiter changed we
// would replay a fragment -- or nothing at all -- and every check would go green without having
// exercised anything. A check that cannot fail checks nothing, so the split is verified to have
// produced the expected body, and throws loudly otherwise.
function extractSandboxedJs(tpl) {
    const OPEN = "___SANDBOXED_JS_FOR_WEB_TEMPLATE___";
    const CLOSE = "___WEB_PERMISSIONS___";
    const parts = tpl.split(OPEN);
    if (parts.length !== 2) {
        throw new Error("delimiter " + OPEN + " missing or duplicated (" + parts.length + " parts)");
    }
    if (parts[1].indexOf(CLOSE) === -1) {
        throw new Error("delimiter " + CLOSE + " missing after " + OPEN);
    }
    const src = parts[1].split(CLOSE)[0];
    // Sentinels: symbols the sandboxed body MUST carry. Their absence means the split landed in
    // the wrong place, not that the template is at fault.
    ["setDefaultConsentState", "updateConsentState", "CONSENT_MODE_SIGNALS", "onUserChoice"].forEach((s) => {
        if (src.indexOf(s) === -1) {
            throw new Error("suspicious sandboxed body: '" + s + "' not found");
        }
    });
    if (src.length < 2000) {
        throw new Error("suspicious sandboxed body: " + src.length + " bytes");
    }
    return src;
}
const SRC = extractSandboxedJs(TPL);

function run(opts) {
    const cookies = Object.assign({}, opts.cookies || {});
    const calls = {defaults: [], updates: [], setCookies: [], injected: []};
    let listener = null;
    const globals = Object.assign({SDDAN: opts.sddan}, opts.globals || {});

    const api = {
        callInWindow: (name, method, _v, fn) => { if (name === "__sdcmpapi" && method === "addEventListener") listener = fn; },
        gtagSet: () => {},
        logToConsole: () => {},
        makeTableMap: () => ({}),
        setDefaultConsentState: (o) => calls.defaults.push(JSON.parse(JSON.stringify(o))),
        updateConsentState: (o) => calls.updates.push(JSON.parse(JSON.stringify(o))),
        // The URL is RECORDED, not just the callback run: without it no test can assert that the
        // CMP is actually loaded, only that nothing threw.
        injectScript: (u, ok) => { calls.injected.push(u); if (ok) { ok(); } },
        encodeUriComponent: encodeURIComponent,
        makeInteger: (v) => parseInt(v, 10),
        getCookieValues: (name) => (cookies[name] === undefined ? [] : [cookies[name]]),
        setCookie: (name, value, options, encode) => {
            calls.setCookies.push({name, value, options, encode});
            // `max-age: -1` is the DELETION instruction, not a write. The stub honours it so the
            // jar reflects the browser's real state: without that, no test can assert that a
            // cookie SURVIVES the event, only count calls.
            if (options && options["max-age"] === -1) { delete cookies[name]; }
            else { cookies[name] = value; }
        },
        copyFromWindow: (name) => globals[name],
        setInWindow: (name, value) => { globals[name] = value; },
        copyFromDataLayer: () => "gtm.init_consent",
        getContainerVersion: () => ({containerId: "GTM-TEST", version: "1", firstPartyServing: false}),
        JSON: JSON
    };

    const data = Object.assign({
        consentMode: true,
        loadCmpScripts: false,
        settingsTable: [{
            ad_storage: "denied", analytics_storage: "denied", personalization_storage: "denied",
            functionality_storage: "denied", security_storage: "denied",
            wait_for_update: 1000, region: "ALL"
        }],
        gtmOnSuccess: () => {}, gtmOnFailure: () => {}
    }, opts.data || {});

    new Function("data", "require", SRC)(data, (n) => {
        if (!(n in api)) throw new Error("API not stubbed: " + n);
        return api[n];
    });

    return {calls, listener, cookies};
}

const TC_ALL_GRANTED = {
    gdprApplies: true, eventStatus: "useractioncomplete",
    purpose: {consents: {1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 8: true}, legitimateInterests: {}},
    vendor: {consents: {755: true}, legitimateInterests: {}}
};
// Purpose 1 only: not 8 (analytics), not 5/6 (personalization), not vendor 755 (the three ad_*).
// Used to check that a change really does push another update.
const TC_ONLY_P1 = {
    gdprApplies: true, eventStatus: "useractioncomplete",
    purpose: {consents: {1: true}, legitimateInterests: {}},
    vendor: {consents: {}, legitimateInterests: {}}
};

// Nothing is granted, so the emitted object equals the settings table's all-denied default
// exactly. This is the case that must NOT push another update.
const TC_ALL_DENIED = {
    gdprApplies: true, eventStatus: "useractioncomplete",
    purpose: {consents: {}, legitimateInterests: {}},
    vendor: {consents: {}, legitimateInterests: {}}
};

const ALL_DENIED_ROW = {
    ad_storage: "denied", analytics_storage: "denied", personalization_storage: "denied",
    functionality_storage: "denied", security_storage: "denied", wait_for_update: 1000
};
function row(over) { return Object.assign({}, ALL_DENIED_ROW, over); }

const SDDAN_LOCAL = {cmp: {scope: "LOCAL", cookieMaxAgeInDays: 390}};
const SDDAN_GROUP = {cmp: {scope: "GROUP", cookieMaxAgeInDays: 390}};

let failures = 0;
let checksRun = 0;
function check(label, cond, detail) {
    checksRun++;
    if (cond) { console.log("  ok   " + label); }
    else { failures++; console.log("  FAIL " + label + (detail ? "  -> " + detail : "")); }
}

// The names `deleteCookie` actually deleted. It writes the same name several times (once per
// domain walked up), hence the de-duplication; the marker is `max-age: -1`, the only place in the
// template that uses it.
function deletedNames(calls) {
    const seen = {};
    const out = [];
    for (let i = 0; i < calls.setCookies.length; i++) {
        const c = calls.setCookies[i];
        if (c.options && c.options["max-age"] === -1 && !seen[c.name]) {
            seen[c.name] = true;
            out.push(c.name);
        }
    }
    return out.sort();
}

// A tcData granting NOTHING and carrying what the deletion needs: it is the absence of consent
// for purpose 1 that opens that path.
function purgeEvent(cookieList) {
    return {
        gdprApplies: true, eventStatus: "useractioncomplete",
        purpose: {consents: {}, legitimateInterests: {}},
        vendor: {consents: {}, legitimateInterests: {}},
        hostName: "www.example.com", cookieList: cookieList
    };
}

console.log("\n1. With no cookie at all: the ordinary path");
{
    const r = run({sddan: SDDAN_LOCAL});
    check("one default set", r.calls.defaults.length === 1);
    check("default all denied", r.calls.defaults[0].ad_storage === "denied" && r.calls.defaults[0].analytics_storage === "denied");
    check("wait_for_update preserved at 1000", r.calls.defaults[0].wait_for_update === 1000, JSON.stringify(r.calls.defaults[0]));
    r.listener(TC_ALL_GRANTED, true);
    check("one update pushed", r.calls.updates.length === 1);
    check("NO cookie written", r.calls.setCookies.length === 0, JSON.stringify(r.calls.setCookies));
}

console.log("\n2. The default comes from the stored cookie");
{
    const r = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "1.1111111", "euconsent-v2": "CP..."}});
    check("default all granted", r.calls.defaults[0].ad_storage === "granted" && r.calls.defaults[0].analytics_storage === "granted", JSON.stringify(r.calls.defaults[0]));
    check("wait_for_update = 0", r.calls.defaults[0].wait_for_update === 0);
    r.listener(TC_ALL_GRANTED, true);
    check("NO update (deduplicated)", r.calls.updates.length === 0, JSON.stringify(r.calls.updates));
    check("and still no write", r.calls.setCookies.length === 0);

    // The cookie is read with NO condition on what surrounds it, and that is the invariant to
    // hold. Requiring a consent record beside it -- `euconsent-v2`, `sdconsent-v2`, `usprivacy` --
    // is tempting, but no such list can be complete from here: which record gets written depends
    // on the configuration (which regulation applies, whether an API is off), which the template
    // cannot see. Every combination the list failed to name would read as "no choice", so
    // all-denied with a non-zero `wait_for_update`, on every page view and with nothing to show
    // for it.
    //
    // The two cases below are the TWO sides of that rule: with a record, and with none at all.
    // They must return the same thing.
    const us = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:1111111", "usprivacy": "1YNN"}});
    check("US path -- the cookie is read", us.calls.defaults[0].analytics_storage === "granted" &&
        us.calls.defaults[0].wait_for_update === 0, JSON.stringify(us.calls.defaults[0]));

    const seul = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:1111111"}});
    check("with NO record beside it -- read all the same",
        seul.calls.defaults[0].analytics_storage === "granted" &&
        seul.calls.defaults[0].wait_for_update === 0,
        JSON.stringify(seul.calls.defaults[0]));
}

console.log("\n3. A mixed cookie: the default reflects it signal by signal");
{
    // v1 order: analytics, functionality, security, personalization, ad_storage, ad_user_data, ad_personalization
    const r = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "1.1010000", "sdconsent-v2": "x"}});
    const d = r.calls.defaults[0];
    check("analytics granted", d.analytics_storage === "granted", JSON.stringify(d));
    check("functionality denied", d.functionality_storage === "denied");
    check("security granted", d.security_storage === "granted");
    check("ad_storage denied", d.ad_storage === "denied");
    check("nothing left to wait for", d.wait_for_update === 0);
}

console.log("\n4. Guards: a MALFORMED string is ignored and nothing changes");
{
    // A higher version and a longer bit string are NOT rejections -- they are the definition of a
    // newer format, and they are covered in section 13. What stays here is what must keep being
    // rejected: a string we cannot read, not a version we do not know.
    const cases = {
        "too short": {"__sdgcm": "1.111111", "euconsent-v2": "x"},
        "non 0/1 character within the first seven": {"__sdgcm": "1.111111x", "euconsent-v2": "x"},
        "no version": {"__sdgcm": "1111111", "euconsent-v2": "x"},
        "empty": {"__sdgcm": "", "euconsent-v2": "x"},
        // split('.') yields three segments here; reading only two would be interpreting sideways
        // a string we do not understand.
        "extra segment": {"__sdgcm": "1.1111111.0", "euconsent-v2": "x"},
        "version zero": {"__sdgcm": "0.1111111", "euconsent-v2": "x"},
        "non numeric version": {"__sdgcm": "v2.1111111", "euconsent-v2": "x"},
        "empty version": {"__sdgcm": ".1111111", "euconsent-v2": "x"},
        // parseInt('1x') is 1: without digit-by-digit validation, this one would get through.
        "numeric version with a suffix": {"__sdgcm": "1x.1111111", "euconsent-v2": "x"}
    };
    for (const label in cases) {
        const r = run({sddan: SDDAN_LOCAL, cookies: cases[label]});
        const d = r.calls.defaults[0];
        check(label, d.ad_storage === "denied" && d.wait_for_update === 1000, JSON.stringify(d));
    }
}

console.log("\n5. Update deduplication");
{
    const r = run({sddan: SDDAN_LOCAL});
    r.listener(TC_ALL_GRANTED, true);
    r.listener(TC_ALL_GRANTED, true);
    check("two identical events -> a single update", r.calls.updates.length === 1, JSON.stringify(r.calls.updates));
    check("and nothing is written", r.calls.setCookies.length === 0);
    r.listener(TC_ONLY_P1, true);
    check("a change pushes an update again", r.calls.updates.length === 2);
    // Purpose 1 only: functionality and security pass, but analytics also needs purpose 8, and
    // every ad_* needs vendor 755. Hence 0,1,1,0,0,0,0.
    check("and the second update carries the new state",
        r.calls.updates[1].analytics_storage === "denied", JSON.stringify(r.calls.updates[1]));
}

console.log("\n6. The template NEVER writes this cookie -- whatever the scope");
{
    // One producer, one consumer. The consent script serving the page owns the cookie; the
    // template READS it for its default and pushes the `update`s. Two producers on one segment
    // means two derivations that do not coincide -- this template takes `ad_user_data` from
    // vendor 755 alone -- so a value that flips between page views depending on who wrote last.
    const cas = [
        ["LOCAL scope", {sddan: SDDAN_LOCAL}],
        ["GROUP scope", {sddan: SDDAN_GROUP}],
        ["no SDDAN", {sddan: undefined}],
        ["cookie already present", {sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:0000000", "euconsent-v2": "x"}}]
    ];
    for (let i = 0; i < cas.length; i++) {
        const r = run(cas[i][1]);
        r.listener(TC_ALL_GRANTED, true);
        check(cas[i][0] + ": no write", r.calls.setCookies.length === 0,
            JSON.stringify(r.calls.setCookies));
    }

    // WITNESS, and it is load-bearing: without it, a template doing NOTHING at all would satisfy
    // the four assertions above.
    const temoin = run({sddan: SDDAN_LOCAL});
    temoin.listener(TC_ALL_GRANTED, true);
    check("witness -- it still pushes its default and its update",
        temoin.calls.defaults.length === 1 && temoin.calls.updates.length === 1);
}

console.log("\n7. A 'not used' signal: absent from the default and from the update");
{
    const r = run({
        sddan: SDDAN_LOCAL,
        data: {settingsTable: [{
            ad_storage: "not used", analytics_storage: "denied", personalization_storage: "denied",
            functionality_storage: "denied", security_storage: "denied", wait_for_update: 1000, region: "ALL"
        }]},
        cookies: {"__sdgcm": "1.1111111", "euconsent-v2": "x"}
    });
    check("ad_storage absent from the default", r.calls.defaults[0].ad_storage === undefined, JSON.stringify(r.calls.defaults[0]));
    check("analytics comes from the cookie", r.calls.defaults[0].analytics_storage === "granted");
    r.listener(TC_ALL_GRANTED, true);
    check("and nothing is written", r.calls.setCookies.length === 0);
}

console.log("\n8. With NO cookie, a choice equal to the default: no update");
{
    // The default IS a push: an update repeating it teaches gtag nothing. This is by far the most
    // common case -- a visitor refusing on their first page view -- so seeding the deduplication
    // from the EMITTED default, and not from the cookie, is what keeps it quiet here.
    const r = run({sddan: SDDAN_LOCAL});
    check("default all denied", r.calls.defaults[0].ad_storage === "denied");
    r.listener(TC_ALL_DENIED, true);
    check("NO update (identical to the default)", r.calls.updates.length === 0, JSON.stringify(r.calls.updates));
    check("and nothing is written", r.calls.setCookies.length === 0);
    // Decision 2 stays independent of decision 1: the cookie is written without an update going out.
    r.listener(TC_ALL_GRANTED, true);
    check("a real change pushes an update again", r.calls.updates.length === 1);
}

console.log("\n9. Diverging regional rows: the ambiguous signal is pushed again");
{
    // gtag applies the FR row to FR visitors and the ALL row to the others -- the template does
    // not know which one this visitor received. Skipping the update on a guess would leave the
    // tags running under a state they never chose, so the ambiguous must be pushed.
    const r = run({
        sddan: SDDAN_LOCAL,
        data: {settingsTable: [row({region: "ALL"}), row({analytics_storage: "granted", region: "FR"})]}
    });
    check("two defaults set", r.calls.defaults.length === 2);
    r.listener(TC_ALL_DENIED, true);
    check("update pushed despite the apparent equality", r.calls.updates.length === 1, JSON.stringify(r.calls.updates));
}

console.log("\n10. No global row: nothing is seeded");
{
    // A table with regional rows only sets NO default at all for visitors outside those regions,
    // so nothing can be asserted about what they received.
    const r = run({sddan: SDDAN_LOCAL, data: {settingsTable: [row({region: "FR"})]}});
    check("the default does carry a region", r.calls.defaults[0].region[0] === "FR", JSON.stringify(r.calls.defaults[0]));
    r.listener(TC_ALL_DENIED, true);
    check("update pushed (nothing seeded)", r.calls.updates.length === 1, JSON.stringify(r.calls.updates));
}

console.log("\n11. 'not used' on ONE row only: the unemitted signal must be pushed");
{
    // The global row marks ad_storage "not used", the FR row emits it. A visitor OUTSIDE FR
    // therefore received no default for ad_storage -- while the update does emit it
    // (defaultConsent is a global accumulator: one row using it is enough to set it to 'denied').
    //
    // Seeding ad_storage from the cookie would suggest gtag already knows it and would drop the
    // update. gtag state does NOT survive from one page view to the next: this visitor would never
    // have received ad_storage, and their tags would stay off despite a granted consent.
    const r = run({
        sddan: SDDAN_LOCAL,
        data: {settingsTable: [row({ad_storage: "not used", region: "ALL"}), row({region: "FR"})]},
        cookies: {"__sdgcm": "1.1111111", "euconsent-v2": "x"}
    });
    check("ad_storage absent from the global default", r.calls.defaults[0].ad_storage === undefined, JSON.stringify(r.calls.defaults[0]));
    check("but present on the FR row", r.calls.defaults[1].ad_storage === "granted", JSON.stringify(r.calls.defaults[1]));
    r.listener(TC_ALL_GRANTED, true);
    check("update pushed (ad_storage never set as a default)", r.calls.updates.length === 1, JSON.stringify(r.calls.updates));
}

console.log("\n12. Segmented container: only the segment we own is read");
{
    // The cookie carries one segment per consent mode, indexed by id. This template owns `g`
    // only; the others belong to other components.
    const complet = run({sddan: SDDAN_LOCAL,
        cookies: {"__sdgcm": "2.g:1:1111111~m:1:1~o:1:0", "euconsent-v2": "x"}});
    check("the g segment is read among the others",
        complet.calls.defaults[0].ad_storage === "granted" && complet.calls.defaults[0].wait_for_update === 0,
        JSON.stringify(complet.calls.defaults[0]));

    // THE case the legacy format could not express: a cookie with no Google segment at all.
    // Segment ABSENT = not decided, so fall back to the settings -- certainly not seven zeros.
    const sansG = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.m:1:1~o:1:0", "euconsent-v2": "x"}});
    check("g segment ABSENT -> not decided, fall back to the settings",
        sansG.calls.defaults[0].analytics_storage === "denied" && sansG.calls.defaults[0].wait_for_update === 1000,
        JSON.stringify(sansG.calls.defaults[0]));

    // ... as distinct from a g present with every bit at zero, which is a DECISION.
    const zeros = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:0000000", "euconsent-v2": "x"}});
    check("g segment at ZERO -> decided, all denied",
        zeros.calls.defaults[0].analytics_storage === "denied" && zeros.calls.defaults[0].wait_for_update === 0,
        JSON.stringify(zeros.calls.defaults[0]));

    // Order means nothing: split on ~ and look the id up.
    const avant = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:1010000~m:1:1", "euconsent-v2": "x"}});
    const apres = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.m:1:1~g:1:1010000", "euconsent-v2": "x"}});
    check("segment order changes nothing",
        JSON.stringify(avant.calls.defaults[0]) === JSON.stringify(apres.calls.defaults[0]),
        JSON.stringify(apres.calls.defaults[0]));

    // Duplicate id: the last occurrence wins.
    const doublon = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:1111111~g:1:0000000", "euconsent-v2": "x"}});
    check("on a duplicate id, the LAST occurrence wins",
        doublon.calls.defaults[0].analytics_storage === "denied", JSON.stringify(doublon.calls.defaults[0]));

    // Newer segment version: bits are appended, so the first seven are read. This is what lets
    // the format be extended without republishing this template.
    const v2 = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:2:101000011~m:1:1", "euconsent-v2": "x"}});
    const d = v2.calls.defaults[0];
    check("newer segment version: analytics read", d.analytics_storage === "granted", JSON.stringify(d));
    check("newer segment version: functionality read", d.functionality_storage === "denied");
    check("newer segment version: security read", d.security_storage === "granted");

    // A structurally broken field is dropped ON ITS OWN.
    const casse = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.casse~g:1:1010000", "euconsent-v2": "x"}});
    check("a broken field does not prevent reading g",
        casse.calls.defaults[0].analytics_storage === "granted", JSON.stringify(casse.calls.defaults[0]));

    // The legacy format is still read, migrated into a g segment.
    const herite = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "1.1010000", "euconsent-v2": "x"}});
    check("the legacy format is still read",
        herite.calls.defaults[0].analytics_storage === "granted" && herite.calls.defaults[0].wait_for_update === 0,
        JSON.stringify(herite.calls.defaults[0]));
}

console.log("\n13. Global Privacy Control takes precedence in the default");
{
    // A row granting EVERYTHING: without it, the GPC denial would be indistinguishable from the
    // table's all-denied default, and the check would check nothing.
    const ALL_GRANTED_ROW = {
        ad_storage: "granted", analytics_storage: "granted", personalization_storage: "granted",
        functionality_storage: "granted", security_storage: "granted",
        wait_for_update: 1000, region: "ALL"
    };
    const GRANTED = {settingsTable: [ALL_GRANTED_ROW]};
    // A FACTORY, never a shared constant: each case must start from a fresh object. A tcData
    // reused from one case to the next can arrive already altered, `onUserChoice`'s entry guard
    // then rejects it for want of a `purpose`, and the case yields zero updates -- which reads
    // exactly like the expected result of a discriminator.
    const usEvent = () => ({gdprApplies: false, eventStatus: "useractioncomplete"});

    // Witness: without the marker the row passes through unchanged. It is what makes the rest readable.
    const off = run({sddan: SDDAN_LOCAL, data: GRANTED});
    check("witness -- without the marker, ad_storage granted", off.calls.defaults[0].ad_storage === "granted");
    check("witness -- wait_for_update preserved", off.calls.defaults[0].wait_for_update === 1000);

    // FIVE denied, TWO kept. An objection to sale is not a refusal of what is strictly necessary:
    // denying security_storage would break authentication and anti-fraud.
    const on = run({sddan: SDDAN_LOCAL, data: GRANTED, cookies: {"__gpcactive": "1"}});
    const g = on.calls.defaults[0];
    check("ad_storage denied", g.ad_storage === "denied", JSON.stringify(g));
    check("analytics_storage denied", g.analytics_storage === "denied");
    check("personalization_storage denied", g.personalization_storage === "denied");
    check("ad_user_data denied", g.ad_user_data === "denied");
    check("ad_personalization denied", g.ad_personalization === "denied");
    check("functionality_storage KEPT", g.functionality_storage === "granted");
    check("security_storage KEPT", g.security_storage === "granted");
    check("nothing left to wait for", g.wait_for_update === 0);

    // The other side of the same rule, and the one `applyStoredSignals` already has pinned in
    // section 7: a signal marked "not used" stays ABSENT under GPC rather than being denied. The
    // marker records what is TRUE, the settings table decides what is SAID.
    //
    // Its neighbour is the discriminator: `analytics_storage` denied proves the denial pass ran,
    // so `ad_storage` being absent is the guard's doing and not a template that emitted nothing.
    const notUsed = run({
        sddan: SDDAN_LOCAL,
        data: {settingsTable: [Object.assign({}, ALL_GRANTED_ROW, {ad_storage: "not used"})]},
        cookies: {"__gpcactive": "1"}
    });
    const nu = notUsed.calls.defaults[0];
    check("a 'not used' signal stays ABSENT under GPC", nu.ad_storage === undefined, JSON.stringify(nu));
    check("while its neighbour is denied", nu.analytics_storage === "denied", JSON.stringify(nu));

    // THE precedence rule: GPC wins over __sdgcm, whatever the cookie says.
    const both = run({
        sddan: SDDAN_LOCAL, data: GRANTED,
        cookies: {"__sdgcm": "1.1111111", "euconsent-v2": "x", "__gpcactive": "1"}
    });
    const b = both.calls.defaults[0];
    check("GPC wins over an all-granted __sdgcm", b.ad_storage === "denied", JSON.stringify(b));
    check("and the two kept signals come from the cookie", b.functionality_storage === "granted");

    // The combination that reading the cookie unconditionally makes reachable: an all-granted
    // `__sdgcm` with NO record beside it. The cookie is read, so the objection must still win --
    // otherwise there would be a path where an active GPC serves an all-granted default.
    const gpcSurCookieSeul = run({
        sddan: SDDAN_LOCAL, data: GRANTED,
        cookies: {"__sdgcm": "1.1111111", "__gpcactive": "1"}
    });
    const gs = gpcSurCookieSeul.calls.defaults[0];
    check("GPC wins over an __sdgcm with NO record beside it", gs.ad_storage === "denied" &&
        gs.analytics_storage === "denied" && gs.ad_user_data === "denied" &&
        gs.ad_personalization === "denied" && gs.personalization_storage === "denied",
        JSON.stringify(gs));
    check("and the two kept signals stay kept", gs.functionality_storage === "granted" &&
        gs.security_storage === "granted", JSON.stringify(gs));

    // NO eligibility guard: no consent cookie needed. That is the point -- gating this on a value
    // that is only correct per cached response would ignore GPC for many US visitors.
    const bare = run({sddan: SDDAN_LOCAL, data: GRANTED, cookies: {"__gpcactive": "1"}});
    check("honoured with no consent cookie at all", bare.calls.defaults[0].ad_storage === "denied");

    // The marker is REMOVED rather than set to '0', so any value other than '1' would be a
    // sideways reading and is ignored.
    const zero = run({sddan: SDDAN_LOCAL, data: GRANTED, cookies: {"__gpcactive": "0"}});
    check("any value other than '1' is ignored", zero.calls.defaults[0].ad_storage === "granted",
        JSON.stringify(zero.calls.defaults[0]));

    // The UPDATE's US path. The marker appears between the default and the event, which is what
    // isolates the update path from the default path: otherwise deduplication would drop the
    // update (the default having already said the same thing) and the test would prove nothing.
    const upd = run({sddan: SDDAN_LOCAL, data: GRANTED});
    upd.cookies["__gpcactive"] = "1";
    upd.listener(usEvent(), true);
    check("an update goes out on the US path", upd.calls.updates.length === 1, JSON.stringify(upd.calls.updates));
    const u = upd.calls.updates[0];
    check("update -- ad_storage denied", u.ad_storage === "denied", JSON.stringify(u));
    check("update -- analytics denied", u.analytics_storage === "denied");
    check("update -- functionality kept", u.functionality_storage === "granted");
    check("update -- security kept", u.security_storage === "granted");

    // Discriminator: the same US event with NO marker and no objecting string denies nothing.
    // Without it, the check above would pass even if the marker were never read.
    // The VALUE is asserted, not the absence of an update: "zero updates" is also what an event
    // rejected at the entry guard produces, so accepting that would prove nothing.
    const noGpc = run({sddan: SDDAN_LOCAL, data: GRANTED});
    noGpc.listener(usEvent(), true);
    check("discriminator -- without the marker, ad_storage stays granted",
        noGpc.calls.updates.length === 1 && noGpc.calls.updates[0].ad_storage === "granted",
        JSON.stringify(noGpc.calls.updates));

    // An objecting usprivacy string keeps working: the marker ADDS to the existing rule, it does
    // not replace it.
    // `__uspapi` must exist AS A FUNCTION: it is the gate of the usprivacy branch, and without it
    // this path cannot be reached at all.
    const usp = run({
        sddan: SDDAN_LOCAL, data: GRANTED,
        cookies: {"usprivacy": "1YYN"}, globals: {"__uspapi": () => {}}
    });
    usp.listener(usEvent(), true);
    check("an objecting usprivacy is still honoured",
        usp.calls.updates.length === 1 && usp.calls.updates[0].ad_storage === "denied",
        JSON.stringify(usp.calls.updates));
}

console.log("\n14. Mutual exclusion: who PUSHES the updates into the dataLayer");
{
    // The most load-bearing invariant in the file. The template
    // claims Consent Mode by setting `ABconsentCMP.enableConsentMode = false`; the CMP script
    // registers its own listener only when that flag is TRUE. The two derivations are not
    // identical -- this template takes ad_user_data from vendor 755 alone -- so two simultaneous
    // writers would contradict each other from one page view to the next.
    //
    // Witness first: without the flag, everything goes out normally. Without it, a template doing
    // nothing at all would satisfy the three assertions that follow.
    const claimed = run({sddan: SDDAN_LOCAL});
    claimed.listener(TC_ALL_GRANTED, true);
    check("witness -- without the flag, the template leads", claimed.calls.defaults.length === 1 &&
        claimed.calls.updates.length === 1 && claimed.calls.setCookies.length === 0);

    const ceded = run({sddan: SDDAN_LOCAL, globals: {ABconsentCMP: {enableConsentMode: true}}});
    check("no default set", ceded.calls.defaults.length === 0, JSON.stringify(ceded.calls.defaults));
    check("the listener is registered all the same", typeof ceded.listener === "function");
    ceded.listener(TC_ALL_GRANTED, true);
    check("no update pushed", ceded.calls.updates.length === 0, JSON.stringify(ceded.calls.updates));
    check("and still no write", ceded.calls.setCookies.length === 0, JSON.stringify(ceded.calls.setCookies));

    // The flag at `false` is the template having ALREADY claimed Consent Mode on an earlier run:
    // it must keep leading, not fall silent.
    const reclaimed = run({sddan: SDDAN_LOCAL, globals: {ABconsentCMP: {enableConsentMode: false}}});
    check("flag at false: the template still leads", reclaimed.calls.defaults.length === 1,
        JSON.stringify(reclaimed.calls.defaults));

    // Cookie deletion is NOT Consent Mode: it does not depend on the exclusion and must keep
    // working when the CMP script is the one leading.
    const purge = run({
        sddan: SDDAN_LOCAL,
        globals: {ABconsentCMP: {enableConsentMode: true}},
        data: {handleCookiesDeletion: true},
        cookies: {"_ga": "x"}
    });
    purge.listener(purgeEvent("_ga"), true);
    check("but cookie deletion stays active", deletedNames(purge.calls).indexOf("_ga") !== -1,
        JSON.stringify(deletedNames(purge.calls)));
}

console.log("\n15. Cookie deletion: the four preservation rules");
{
    // This path only opens without consent for purpose 1.
    const LIST = "_ga,_fbp,sd_keep,x_suffix,mid_dle,euconsent-v2,usprivacy";
    const PRESENT = {"_ga": "1", "_fbp": "1", "sd_keep": "1", "x_suffix": "1", "mid_dle": "1",
                     "euconsent-v2": "1", "usprivacy": "1"};

    // The consent cookies are exempt BY DESIGN: deleting them would destroy the very choice the
    // deletion is meant to honour.
    const base = run({sddan: SDDAN_LOCAL, data: {handleCookiesDeletion: true}, cookies: PRESENT});
    base.listener(purgeEvent(LIST), true);
    const d0 = deletedNames(base.calls);
    check("euconsent-v2 never deleted", d0.indexOf("euconsent-v2") === -1, JSON.stringify(d0));
    check("usprivacy never deleted", d0.indexOf("usprivacy") === -1);
    check("the rest is deleted", d0.indexOf("_ga") !== -1 && d0.indexOf("_fbp") !== -1);

    const rules = {
        "cookie_equals": {value: "sd_keep", kept: "sd_keep", gone: "_ga"},
        "cookie_begins_with": {value: "sd_", kept: "sd_keep", gone: "_ga"},
        "cookie_ends_with": {value: "_suffix", kept: "x_suffix", gone: "_ga"},
        "cookie_contains": {value: "id_dl", kept: "mid_dle", gone: "_ga"}
    };
    for (const rule in rules) {
        const c = rules[rule];
        const r = run({
            sddan: SDDAN_LOCAL, cookies: PRESENT,
            data: {handleCookiesDeletion: true, cookieNames: [{value: c.value, rule: rule}]}
        });
        r.listener(purgeEvent(LIST), true);
        const del = deletedNames(r.calls);
        check(rule + " preserves " + c.kept, del.indexOf(c.kept) === -1, JSON.stringify(del));
        check(rule + " still deletes " + c.gone, del.indexOf(c.gone) !== -1, JSON.stringify(del));
    }

    // The flag governs everything: without it nothing is deleted, even with a list supplied.
    const off = run({sddan: SDDAN_LOCAL, cookies: PRESENT, data: {handleCookiesDeletion: false}});
    off.listener(purgeEvent(LIST), true);
    check("flag off: nothing is deleted", deletedNames(off.calls).length === 0,
        JSON.stringify(deletedNames(off.calls)));

    // And consent for purpose 1 closes the path again, whatever the flag says.
    const consented = run({sddan: SDDAN_LOCAL, cookies: PRESENT, data: {handleCookiesDeletion: true}});
    consented.listener(Object.assign(purgeEvent(LIST), {
        purpose: {consents: {1: true}, legitimateInterests: {}}
    }), true);
    check("purpose 1 granted: nothing is deleted", deletedNames(consented.calls).length === 0,
        JSON.stringify(deletedNames(consented.calls)));
}

console.log("\n16. The .tpl's ___TESTS___ section stays structurally sound");
{
    // What this checks, and nothing more: the section exists, its scenarios are anchored at
    // column 0, each carries a `code:` block, and no two share a name.
    //
    // This is NOT YAML validation -- the repo has no dependencies and the README promises
    // "nothing but node". What it catches is the real mistake: a scenario appended at the wrong
    // indentation, or a duplicate name, which only the GTM editor would otherwise see.
    const testsSection = TPL.split("___TESTS___")[1].split("___NOTES___")[0];
    const names = [];
    let malformed = 0;
    const lines = testsSection.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("- name:") === 0) {
            names.push(lines[i].substring(7).trim());
            let hasCode = false;
            for (let j = i + 1; j < lines.length && lines[j].indexOf("- name:") !== 0; j++) {
                if (lines[j].indexOf("  code:") === 0) { hasCode = true; break; }
            }
            if (!hasCode) { malformed++; }
        }
    }
    check("the section carries scenarios", names.length > 0, String(names.length));
    check("each one carries a code: block", malformed === 0, malformed + " sans code");
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    check("no duplicate name", dupes.length === 0, JSON.stringify(dupes));
    // The editor REFUSES a scenario name starting with "_", and it is the only thing that says
    // so: nothing in the file flags it, so the mistake only surfaces at publication time -- and a
    // name taken from the cookie it exercises falls into it naturally.
    const souligne = names.filter((n) => n.indexOf("_") === 0);
    check("no name starts with an underscore", souligne.length === 0, JSON.stringify(souligne));
    // The EXACT inventory rather than a count: a scenario that disappears is then named, and the
    // check cannot be satisfied by one scenario replacing another.
    const ATTENDUS = [
        "default settings sent",
        "the default comes from __sdgcm",
        "the stored signals are read with no consent record beside them",
        "a malformed __sdgcm falls back instead of being read sideways",
        "an extra segment is still rejected",
        "a newer segment version is read for the signals it knows",
        "a cookie carrying no g segment falls back",
        "the GPC marker denies five signals and keeps two",
        "the template never writes the consent mode cookie"
    ];
    const manquants = ATTENDUS.filter((n) => names.indexOf(n) === -1);
    const inattendus = names.filter((n) => ATTENDUS.indexOf(n) === -1);
    check("the scenario inventory is exact",
        manquants.length === 0 && inattendus.length === 0,
        "manquants=" + JSON.stringify(manquants) + " inattendus=" + JSON.stringify(inattendus));
}

console.log("\n17. The cookies this setup OWNS survive its own deletion sweep");
{
    // The deletion path opens when purpose 1 is NOT granted -- exactly when these cookies carry
    // the refusal that has to be remembered.
    // The list is the COMPLETE set of cookies this setup writes. `__sdusnat` holds the detailed
    // US choices, which the four characters of `usprivacy` cannot carry -- that format is frozen
    // by `__uspapi` and its third-party readers.
    const OWNED = ["euconsent-v2", "sdconsent-v2", "usprivacy", "__sdgcm", "__gpcactive",
                   "__sdusnat"];
    const LIST = OWNED.join(",") + ",_ga";
    const PRESENT = {"euconsent-v2": "CP", "sdconsent-v2": "S", "usprivacy": "1YNN",
                     "__sdgcm": "1.1111111", "__gpcactive": "1", "__sdusnat": "1222" + "1".repeat(20),
                     "_ga": "x"};

    const r = run({sddan: SDDAN_LOCAL, data: {handleCookiesDeletion: true}, cookies: PRESENT});
    r.listener(purgeEvent(LIST), true);
    const del = deletedNames(r.calls);

    for (let i = 0; i < OWNED.length; i++) {
        check(OWNED[i] + " is never deleted", del.indexOf(OWNED[i]) === -1, JSON.stringify(del));
    }

    // The discriminator, without which this whole block would be satisfied by a template that
    // deletes nothing at all.
    check("a third-party cookie in the same list is deleted", del.indexOf("_ga") !== -1,
        JSON.stringify(del));

    // This cookie comes from ELSEWHERE: the template reads it, it does not write it. That makes
    // its exemption matter more, not less -- deleting it would destroy another producer's data,
    // and the next load's default would start from nothing.
    //
    // The JAR is asserted, not a call count: the cookie's survival is the invariant.
    check("__sdgcm SURVIVES the event intact", r.cookies["__sdgcm"] === "1.1111111",
        JSON.stringify(r.cookies["__sdgcm"]));
    check("and the template wrote nothing at all", r.calls.setCookies.every(
        (c) => c.options && c.options["max-age"] === -1), JSON.stringify(r.calls.setCookies));

    // The jar must reflect the real deletion, otherwise the assertion above proves nothing.
    check("the jar reflects the third-party deletion", r.cookies["_ga"] === undefined,
        JSON.stringify(r.cookies["_ga"]));

    // An exemption rule from the editor must not SHRINK the built-in list: it adds to it.
    const custom = run({
        sddan: SDDAN_LOCAL, cookies: PRESENT,
        data: {handleCookiesDeletion: true, cookieNames: [{value: "_ga", rule: "cookie_equals"}]}
    });
    custom.listener(purgeEvent(LIST), true);
    const del2 = deletedNames(custom.calls);
    check("an editor rule adds to the built-in exemptions",
        del2.length === 0 && custom.cookies["__sdgcm"] !== undefined, JSON.stringify(del2));
}

console.log("\n18. GPC acts on the consent-mode STATUS, never on LOADING the CMP");
{
    // The marker changes what is DECLARED to gtag. It must change nothing about script injection:
    // cutting the load would deprive the visitor of the banner -- their only way to revisit the
    // objection -- for a signal that only asks not to sell. The marker would then be impossible to
    // clear, the banner being what removes it.
    const ROW = {
        ad_storage: "granted", analytics_storage: "granted", personalization_storage: "granted",
        functionality_storage: "granted", security_storage: "granted",
        wait_for_update: 1000, region: "ALL"
    };
    const CMP = {settingsTable: [ROW], loadCmpScripts: true, partnerId: "1020", configId: "hmDnl"};

    const sans = run({sddan: SDDAN_LOCAL, data: CMP});
    const avec = run({sddan: SDDAN_LOCAL, data: CMP, cookies: {"__gpcactive": "1"}});

    // Witness: without it, a harness injecting NOTHING would satisfy the equality below.
    check("witness -- two scripts injected without the marker", sans.calls.injected.length === 2,
        JSON.stringify(sans.calls.injected));
    check("witness -- the stub then the bundle",
        sans.calls.injected[0].indexOf("/stub") !== -1 && sans.calls.injected[1].indexOf("/cmp") !== -1,
        JSON.stringify(sans.calls.injected));

    check("the marker removes no script", avec.calls.injected.length === 2,
        JSON.stringify(avec.calls.injected));
    check("and they are exactly the same URLs",
        JSON.stringify(avec.calls.injected) === JSON.stringify(sans.calls.injected),
        JSON.stringify(avec.calls.injected));

    // The discriminator: without it, the equality above would also be satisfied by an INERT GPC,
    // that is, by a marker doing nothing at all.
    check("while the status itself does change",
        sans.calls.defaults[0].ad_storage === "granted" && avec.calls.defaults[0].ad_storage === "denied",
        JSON.stringify([sans.calls.defaults[0].ad_storage, avec.calls.defaults[0].ad_storage]));
    check("and loading is unchanged when the CMP is switched off by CONFIGURATION",
        run({sddan: SDDAN_LOCAL, data: {settingsTable: [ROW]}, cookies: {"__gpcactive": "1"}})
            .calls.injected.length === 0);
}

console.log("\n19. The US path DECIDES, instead of borrowing another regulation");
{
    // `hasConsent` returns `!gdprApplies || <lookup>`: outside the GDPR, everything is granted.
    // Flipping `tcData.gdprApplies` would be one way to get "no consent" out of it, but it mutates
    // the CMP's object, and it makes the "five denied, TWO kept" rule impossible to hold: an
    // all-denied derivation catches functionality and security along with the rest.
    const TOUT_ACCORDE = {
        ad_storage: "granted", analytics_storage: "granted", personalization_storage: "granted",
        functionality_storage: "granted", security_storage: "granted",
        wait_for_update: 1000, region: "ALL"
    };
    const US = {settingsTable: [TOUT_ACCORDE]};
    const USPAPI = {"__uspapi": function () { return undefined; }};
    // A FACTORY: one of the tests below asserts that the US rule does not mutate its argument, so
    // each case must start from a fresh object.
    const evUs = () => ({gdprApplies: false, eventStatus: "useractioncomplete"});

    // The marker appears AFTER the default (the consent script writes it during the page view):
    // the default goes out granted, and it is the update that must deny. This is the case that
    // shows the two kept signals, the others being absorbed by deduplication.
    const objecte = run({sddan: SDDAN_LOCAL, data: US, globals: USPAPI});
    objecte.cookies["__gpcactive"] = "1";
    objecte.listener(evUs(), true);
    const u = objecte.calls.updates[0] || {};
    check("US objection -- ad_storage denied", u.ad_storage === "denied", JSON.stringify(u));
    check("US objection -- analytics_storage denied", u.analytics_storage === "denied");
    check("US objection -- personalization_storage denied", u.personalization_storage === "denied");
    check("US objection -- ad_user_data denied", u.ad_user_data === "denied");
    check("US objection -- ad_personalization denied", u.ad_personalization === "denied");
    check("US objection -- functionality_storage KEPT", u.functionality_storage === "granted", JSON.stringify(u));
    check("US objection -- security_storage KEPT", u.security_storage === "granted", JSON.stringify(u));
    check("and nothing is written, even under an objection", objecte.calls.setCookies.length === 0,
        JSON.stringify(objecte.calls.setCookies));

    // `usprivacy` says the same thing as the marker, and must produce the same verdict.
    const parChaine = run({sddan: SDDAN_LOCAL, data: US, cookies: {"usprivacy": "1YYN"}, globals: USPAPI});
    parChaine.listener(evUs(), true);
    const uc = parChaine.calls.updates[0] || {};
    check("the usprivacy opt-out yields the same verdict",
        uc.ad_storage === "denied" && uc.functionality_storage === "granted", JSON.stringify(uc));

    // An ALL-DENIED row for these two cases: the default then goes out denied, so a "granted"
    // verdict shows up as an update. With the all-granted row, deduplication absorbs it and the
    // test would pass without exercising anything.
    const TOUT_REFUSE = {
        ad_storage: "denied", analytics_storage: "denied", personalization_storage: "denied",
        functionality_storage: "denied", security_storage: "denied",
        wait_for_update: 1000, region: "ALL"
    };
    const US_REFUSE = {settingsTable: [TOUT_REFUSE]};

    // A string with NO objection is a decision, not an absence: everything granted.
    const pasObjecte = run({sddan: SDDAN_LOCAL, data: US_REFUSE, cookies: {"usprivacy": "1YNN"}, globals: USPAPI});
    pasObjecte.listener(evUs(), true);
    const up = pasObjecte.calls.updates[0] || {};
    check("no objection -- all granted",
        up.ad_storage === "granted" && up.analytics_storage === "granted", JSON.stringify(up));

    // An objection ON an all-denied row: the ONLY case where routing the two kept signals through
    // the verdict would show. With the all-granted row, the `setting.X` fallback returns 'granted'
    // anyway, so the "two kept" assertion above passes without exercising the rule.
    const objecteRefuse = run({sddan: SDDAN_LOCAL, data: US_REFUSE, cookies: {"usprivacy": "1YYN"}, globals: USPAPI});
    objecteRefuse.listener(evUs(), true);
    const ur = objecteRefuse.calls.updates[0] || {};
    check("objection on a denying row -- the two kept signals stay granted",
        ur.functionality_storage === "granted" && ur.security_storage === "granted", JSON.stringify(ur));

    // WITNESS, and load-bearing: outside the US, "the GDPR does not apply" still means
    // "everything is allowed". Without it, a verdict denying by default would go unnoticed and
    // would switch off measurement for the rest of the world.
    const horsUs = run({sddan: SDDAN_LOCAL, data: US_REFUSE});
    horsUs.listener(evUs(), true);
    const uh = horsUs.calls.updates[0] || {};
    check("witness -- outside the US, everything stays granted",
        uh.ad_storage === "granted" && uh.analytics_storage === "granted", JSON.stringify(uh));

    // The object belongs to the CMP. Mutating it would borrow another regulation's machinery to
    // say something simple, and any other reader of that object would inherit the change.
    const ev = evUs();
    const sansMutation = run({sddan: SDDAN_LOCAL, data: US, cookies: {"__gpcactive": "1"}, globals: USPAPI});
    sansMutation.listener(ev, true);
    check("tcData is NOT mutated", ev.gdprApplies === false, JSON.stringify(ev));

    // A US objection also closes purpose 1, and therefore opens the cookie deletion path. Stated
    // here rather than reached as a side effect of how the verdict is derived.
    const purge = run({sddan: SDDAN_LOCAL, data: {settingsTable: [TOUT_ACCORDE], handleCookiesDeletion: true},
        cookies: {"__gpcactive": "1", "_ga": "x"}, globals: USPAPI});
    purge.listener(Object.assign(evUs(), {hostName: "example.com", cookieList: "_ga"}), true);
    check("a US objection still opens the deletion",
        deletedNames(purge.calls).indexOf("_ga") !== -1, JSON.stringify(deletedNames(purge.calls)));
}

// Assertion floor: "zero red" must never be able to mean "nothing ran". A section deleted by
// accident would otherwise come out ALL GREEN. Raise it along with the harness.
const MIN_CHECKS = 139;
if (checksRun < MIN_CHECKS) {
    failures++;
    console.log("\n  FAIL only " + checksRun + " assertions ran, floor = " + MIN_CHECKS);
}

console.log("\n" + checksRun + " assertions");
console.log(failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
