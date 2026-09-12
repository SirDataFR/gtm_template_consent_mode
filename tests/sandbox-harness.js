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
    ["setDefaultConsentState", "CONSENT_MODE_SIGNALS", "onUserChoice", "loadRegularStub"].forEach((s) => {
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

function extractJsonSection(open, close) {
    const afterOpen = TPL.split(open);
    if (afterOpen.length !== 2 || afterOpen[1].indexOf(close) === -1) {
        throw new Error("cannot extract " + open);
    }
    return afterOpen[1].split(close)[0].trim();
}

function run(opts) {
    const cookies = Object.assign({}, opts.cookies || {});
    const calls = {defaults: [], defaultStates: [], updates: [], setCookies: [], injected: [], injectionStates: [], successes: 0, failures: 0};
    let listener = null;
    const globals = Object.assign({SDDAN: opts.sddan}, opts.globals || {});

    function getPath(pathName) {
        const parts = pathName.split(".");
        let value = globals;
        for (let i = 0; i < parts.length; i++) {
            if (value === undefined || value === null) return undefined;
            value = value[parts[i]];
        }
        return value;
    }

    function getOwner(pathName) {
        const parts = pathName.split(".");
        parts.pop();
        return parts.length ? getPath(parts.join(".")) : globals;
    }

    function setPath(pathName, value, overrideExisting) {
        const parts = pathName.split(".");
        let owner = globals;
        for (let i = 0; i < parts.length - 1; i++) {
            if (owner[parts[i]] === undefined || owner[parts[i]] === null) return false;
            owner = owner[parts[i]];
        }
        const key = parts[parts.length - 1];
        if (!overrideExisting && owner[key] !== undefined) return false;
        owner[key] = value;
        return true;
    }

    // The documented API returns a copied/coerced sandbox value, not an identity handle. Arrays
    // are copied here so production code cannot pass by comparing host references.
    function copyWindowValue(pathName) {
        const value = getPath(pathName);
        return Array.isArray(value) ? value.slice() : value;
    }

    const api = {
        callInWindow: (name, ...args) => {
            if (name === "__sdcmpapi" && args[0] === "addEventListener") {
                listener = args[2];
            }
            const fn = getPath(name);
            if (typeof fn !== "function") return undefined;
            return fn.apply(getOwner(name), args);
        },
        gtagSet: () => {},
        logToConsole: () => {},
        makeTableMap: () => ({}),
        setDefaultConsentState: (o) => {
            calls.defaults.push(JSON.parse(JSON.stringify(o)));
            const cmp = globals.ABconsentCMP || {};
            calls.defaultStates.push({googleDefaultSet: cmp.gtmGoogleConsentModeDefaultSet});
        },
        updateConsentState: (o) => calls.updates.push(JSON.parse(JSON.stringify(o))),
        // The URL is RECORDED, not just the callback run: without it no test can assert that the
        // CMP is actually loaded, only that nothing threw.
        injectScript: (u, ok, fail) => {
            calls.injected.push(u);
            const cmp = globals.ABconsentCMP || {};
            calls.injectionStates.push({
                facebook: cmp.gtmFacebookConsentMode,
                openai: cmp.gtmOpenAiConsentMode,
                facebookUpdatesOwnedByGtm: cmp.gtmFacebookConsentModeUpdatesOwnedByGtm,
                openaiUpdatesOwnedByGtm: cmp.gtmOpenAiConsentModeUpdatesOwnedByGtm,
                enableConsentMode: cmp.enableConsentMode,
                googleDefaultSet: cmp.gtmGoogleConsentModeDefaultSet,
                miniStubApis: Object.assign({}, cmp.gtmTemplateMiniStubApis || {})
            });
            if (opts.failInjection && u.indexOf(opts.failInjection) !== -1) {
                if (fail) fail();
                return;
            }
            if (u.indexOf("cmp_loader.js") !== -1) {
                const callbacks = (globals.sdCmpTemplateCallback || []).slice();
                callbacks.forEach((callback) => callback());
            }
            if (ok) { ok(); }
        },
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
        copyFromWindow: copyWindowValue,
        setInWindow: setPath,
        aliasInWindow: (toPath, fromPath) => setPath(toPath, getPath(fromPath), true),
        createQueue: (arrayKey) => {
            let queue = getPath(arrayKey);
            if (!Array.isArray(queue)) {
                queue = [];
                setPath(arrayKey, queue, true);
            }
            return function () {
                for (let i = 0; i < arguments.length; i++) queue.push(arguments[i]);
            };
        },
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

    const success = data.gtmOnSuccess;
    const failure = data.gtmOnFailure;
    data.gtmOnSuccess = () => { calls.successes++; success(); };
    data.gtmOnFailure = () => { calls.failures++; failure(); };

    new Function("data", "require", SRC)(data, (n) => {
        if (!(n in api)) throw new Error("API not stubbed: " + n);
        return api[n];
    });

    return {calls, listener, cookies, globals};
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
    check("template emits no update", r.calls.updates.length === 0);
    check("NO cookie written", r.calls.setCookies.length === 0, JSON.stringify(r.calls.setCookies));
}

console.log("\n2. The default comes from the stored cookie");
{
    const r = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "1.1111111", "euconsent-v2": "CP..."}});
    check("default all granted", r.calls.defaults[0].ad_storage === "granted" && r.calls.defaults[0].analytics_storage === "granted", JSON.stringify(r.calls.defaults[0]));
    check("wait_for_update = 0", r.calls.defaults[0].wait_for_update === 0);
    check("template emits no update", r.calls.updates.length === 0, JSON.stringify(r.calls.updates));
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

console.log("\n6. The template NEVER writes this cookie -- whatever the scope");
{
    // One producer, one consumer. The consent script serving the page owns the cookie; the
    // template READS it for its default while the CMP pushes the `update`s. Two producers on one segment
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
        check(cas[i][0] + ": no write", r.calls.setCookies.length === 0,
            JSON.stringify(r.calls.setCookies));
    }

    // WITNESS, and it is load-bearing: without it, a template doing NOTHING at all would satisfy
    // the four assertions above.
    const temoin = run({sddan: SDDAN_LOCAL});
    check("witness -- it still pushes its default but no update",
        temoin.calls.defaults.length === 1 && temoin.calls.updates.length === 0);
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
    check("flag off: no listener is registered", off.listener === null);
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


function commandList(queue) {
    return (queue || []).map((entry) => Array.prototype.slice.call(entry));
}

function named(commands, name) {
    return commands.filter((command) => command[0] === name);
}

function without(commands, names) {
    return commands.filter((command) => names.indexOf(command[0]) === -1);
}

console.log("\n19. Vendor selectors, ownership contract, and minimal permissions");
{
    const parameters = JSON.parse(extractJsonSection(
        "___TEMPLATE_PARAMETERS___", "___SANDBOXED_JS_FOR_WEB_TEMPLATE___"));
    const group = parameters[0] || {};
    const selectors = group.subParams || [];
    check("vendor compatibility stays the first top-level group", group.name === "vendorConsentModeOverrides", group.name);
    check("the group links the official vendor templates",
        (group.help || "").indexOf("https://github.com/facebook/GoogleTagManager-WebTemplate-For-FacebookPixel") !== -1 &&
        (group.help || "").indexOf("https://github.com/openai/ads-measurement-pixel-gtm-template") !== -1);
    check("both vendor overrides remain tri-state selectors",
        selectors.length === 2 && selectors.every((selector) =>
            selector.type === "SELECT" && selector.selectItems.length === 3 && selector.defaultValue === "inherit"));
    const uiCopy = group.displayName + " " + group.help + " " + selectors.map((selector) =>
        selector.displayName + " " + selector.help + " " + selector.selectItems.map((item) => item.displayValue).join(" ")
    ).join(" ");
    check("enabled wording describes defaults and CMP-owned updates",
        uiCopy.indexOf("default") !== -1 && uiCopy.indexOf("CMP sends updates") !== -1, uiCopy);
    check("UI no longer says GTM owns vendor updates",
        uiCopy.indexOf("GTM owns consent commands") === -1 && uiCopy.indexOf("responsible for updates") === -1, uiCopy);
    check("tooltips keep compatibility and SDK download limits",
        uiCopy.indexOf("Custom HTML") !== -1 && uiCopy.indexOf("third-party") !== -1 &&
        uiCopy.indexOf("does not prevent") !== -1 && uiCopy.indexOf("SDK") !== -1);

    const permissionsText = extractJsonSection("___WEB_PERMISSIONS___", "___TESTS___");
    const permissionObjects = JSON.parse(permissionsText);
    const accessGlobals = permissionObjects.filter((permission) =>
        permission.instance.key.publicId === "access_globals")[0];
    const globalItems = accessGlobals.instance.param.filter((parameter) => parameter.key === "keys")[0].value.listItem;
    const rows = globalItems.map((item) => {
        const row = {};
        for (let i = 0; i < item.mapKey.length; i++) {
            const key = item.mapKey[i].string;
            const value = item.mapValue[i];
            row[key] = value.type === 1 ? value.string : value.boolean;
        }
        return [row.key, row.read, row.write, row.execute];
    });
    ["__tcfapi", "__sdcmpapi", "__uspapi", "__gpp", "__gpp.queue", "__gpp.events",
        "fbq", "fbq.queue", "fbq.queue.push", "fbq.push", "_fbq", "_fbq.queue",
        "oaiq", "oaiq.q", "oaiq.queue", "oaiq.queue.push"].forEach((key) => {
        check("access_globals includes " + key, rows.some((row) => row[0] === key), JSON.stringify(rows));
    });
    const probeCalls = Array.from(SRC.matchAll(/queuesShareStorage\('([^']+)',\s*'([^']+)'\)/g));
    check("queue storage probes are statically discoverable", probeCalls.length === 2,
        JSON.stringify(probeCalls.map((match) => [match[1], match[2]])));
    probeCalls.forEach((match) => {
        [".push", ".splice"].forEach((suffix) => {
            const executablePath = match[1] + suffix;
            check("probe execute permission is exact for " + executablePath,
                rows.some((row) => row[0] === executablePath && row[3] === true), JSON.stringify(rows));
        });
    });
    check("initialized SDK detection permissions stay minimal",
        rows.some((row) => row[0] === "fbq.callMethod" && row[1] === true && row[2] === false && row[3] === false) &&
        rows.some((row) => row[0] === "oaiq.__oaiqInitialized" && row[1] === true && row[2] === false && row[3] === false),
        JSON.stringify(rows));
    check("no callMethod.apply permission is needed",
        !rows.some((row) => row[0] === "fbq.callMethod.apply"), JSON.stringify(rows));
    check("no vendor SDK domain was added to inject_script",
        permissionsText.indexOf("connect.facebook.net") === -1 && permissionsText.indexOf("bzrcdn.openai.com") === -1);
    check("template creates no locator iframe or message listener",
        SRC.indexOf("Locator") === -1 && SRC.indexOf("postMessage") === -1 && SRC.indexOf("addEventListener('message'") === -1);
}

console.log("\n20. Same-window mini-stubs and takeover handoff");
{
    const thirdPartyUsp = function () { return "publisher"; };
    const valid = run({sddan: SDDAN_LOCAL, globals: {__uspapi: thirdPartyUsp}, data: {
        loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    check("valid loader configuration installs missing mini-stubs",
        typeof valid.globals.__tcfapi === "function" && typeof valid.globals.__sdcmpapi === "function" &&
        typeof valid.globals.__gpp === "function");
    check("pre-existing third-party CMP API is never replaced", valid.globals.__uspapi === thirdPartyUsp);
    check("handoff marks only APIs actually installed by the template",
        JSON.stringify(valid.globals.ABconsentCMP.gtmTemplateMiniStubApis) ===
        JSON.stringify({__tcfapi: true, __sdcmpapi: true, __gpp: true}),
        JSON.stringify(valid.globals.ABconsentCMP.gtmTemplateMiniStubApis));

    const tcfArgs = ["getTCData", 2, function () {}, {vendor: 755}];
    if (typeof valid.globals.__tcfapi === "function") valid.globals.__tcfapi.apply(null, tcfArgs);
    const tcfQueue = typeof valid.globals.__tcfapi === "function" ? valid.globals.__tcfapi() : [];
    check("TCF no-command call returns its recoverable queue",
        tcfQueue === valid.globals.__tcfapi() && tcfQueue.length === 1);
    check("TCF queue preserves every original argument", tcfQueue[0] && tcfQueue[0].length === 4 &&
        tcfQueue[0][0] === tcfArgs[0] && tcfQueue[0][2] === tcfArgs[2] && tcfQueue[0][3] === tcfArgs[3]);
    let tcfPing = null;
    if (typeof valid.globals.__tcfapi === "function") valid.globals.__tcfapi("ping", 2, (value, ok) => { tcfPing = [value, ok]; });
    check("TCF ping reports a pending stub", tcfPing && tcfPing[1] === true &&
        tcfPing[0].cmpLoaded === false && tcfPing[0].cmpStatus === "stub" && tcfPing[0].gdprApplies === undefined,
        JSON.stringify(tcfPing));

    const sdArgs = ["getConfig", 2, function () {}, "parameter"];
    if (typeof valid.globals.__sdcmpapi === "function") valid.globals.__sdcmpapi.apply(null, sdArgs);
    const sdQueue = typeof valid.globals.__sdcmpapi === "function" ? valid.globals.__sdcmpapi() : [];
    check("Sirdata API queue is recoverable and preserves all arguments",
        sdQueue === valid.globals.__sdcmpapi() && sdQueue.length === 1 &&
        sdQueue[0].length === 4 && sdQueue[0][3] === "parameter");

    const usp = run({sddan: SDDAN_LOCAL, data: {loadCmpScripts: true, partnerId: "1020", configId: "public"}});
    const uspArgs = ["getUSPData", 1, function () {}, "parameter"];
    if (typeof usp.globals.__uspapi === "function") usp.globals.__uspapi.apply(null, uspArgs);
    const uspQueue = typeof usp.globals.__uspapi === "function" ? usp.globals.__uspapi() : [];
    check("USP queue is recoverable and preserves all arguments",
        uspQueue.length === 1 && uspQueue[0].length === 4 && uspQueue[0][3] === "parameter");
    let uspPing = null;
    if (typeof usp.globals.__uspapi === "function") usp.globals.__uspapi("ping", 1, (value, ok) => { uspPing = [value, ok]; });
    check("USP ping reports not loaded", uspPing && uspPing[1] === true && uspPing[0].uspapiLoaded === false,
        JSON.stringify(uspPing));
    check("USP installation is marked for takeover",
        usp.globals.ABconsentCMP.gtmTemplateMiniStubApis.__uspapi === true);

    let gppPing = null;
    if (typeof valid.globals.__gpp === "function") valid.globals.__gpp("ping", (value, ok) => { gppPing = [value, ok]; });
    check("GPP ping reports a stub that is not ready",
        gppPing && gppPing[1] === true && gppPing[0].cmpStatus === "stub" &&
        gppPing[0].signalStatus === "not ready", JSON.stringify(gppPing));

    let registered = null;
    if (typeof valid.globals.__gpp === "function") {
        valid.globals.__gpp("addEventListener", (value, ok) => { registered = [value, ok]; }, "client");
        valid.globals.__gpp("getGPPData", function () {}, "field");
    }
    check("GPP exposes takeover-compatible queue and events arrays",
        Array.isArray(valid.globals.__gpp.queue) && Array.isArray(valid.globals.__gpp.events));
    check("GPP addEventListener responds immediately with a stable listener id",
        registered && registered[1] === true && registered[0].eventName === "listenerRegistered" &&
        registered[0].listenerId === 1 && registered[0].pingData.signalStatus === "not ready", JSON.stringify(registered));
    check("GPP event is stored for takeover",
        valid.globals.__gpp.events[0] && valid.globals.__gpp.events[0].id === 1 &&
        valid.globals.__gpp.events[0].parameter === "client");
    check("other GPP commands retain all arguments in .queue",
        valid.globals.__gpp.queue[0] && valid.globals.__gpp.queue[0].length === 3 &&
        valid.globals.__gpp.queue[0][0] === "getGPPData" && valid.globals.__gpp.queue[0][2] === "field");

    const noLoader = run({sddan: SDDAN_LOCAL, data: {loadCmpScripts: false, partnerId: "1020", configId: "public"}});
    check("mini-stubs are absent when CMP script loading is disabled",
        noLoader.globals.__tcfapi === undefined && noLoader.globals.__sdcmpapi === undefined &&
        noLoader.globals.__uspapi === undefined && noLoader.globals.__gpp === undefined);
    const incomplete = run({sddan: SDDAN_LOCAL, data: {loadCmpScripts: true, partnerId: "1020"}});
    check("mini-stubs are absent for incomplete loader configuration",
        incomplete.globals.__tcfapi === undefined && incomplete.globals.__sdcmpapi === undefined &&
        incomplete.globals.__uspapi === undefined && incomplete.globals.__gpp === undefined);

    function thirdPartyApi() { return "third-party"; }
    thirdPartyApi.queue = ["keep"];
    thirdPartyApi.events = ["keep-event"];
    const allThirdParty = run({sddan: SDDAN_LOCAL, globals: {
        __tcfapi: thirdPartyApi, __sdcmpapi: thirdPartyApi, __uspapi: thirdPartyApi, __gpp: thirdPartyApi
    }, data: {loadCmpScripts: true, partnerId: "1020", configId: "public"}});
    check("no pre-existing CMP API is replaced",
        allThirdParty.globals.__tcfapi === thirdPartyApi && allThirdParty.globals.__sdcmpapi === thirdPartyApi &&
        allThirdParty.globals.__uspapi === thirdPartyApi && allThirdParty.globals.__gpp === thirdPartyApi);
    check("no false handoff marker is published for third-party APIs",
        !allThirdParty.globals.ABconsentCMP.gtmTemplateMiniStubApis ||
        Object.keys(allThirdParty.globals.ABconsentCMP.gtmTemplateMiniStubApis).length === 0,
        JSON.stringify(allThirdParty.globals.ABconsentCMP.gtmTemplateMiniStubApis));
}

console.log("\n21. Activation overrides, CMP ownership, and loader ordering");
{
    const enabled = run({sddan: SDDAN_LOCAL, data: {
        facebookConsentModeOverride: "enabled", openAiConsentModeOverride: "enabled",
        loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    check("enabled publishes activation overrides",
        enabled.globals.ABconsentCMP.gtmFacebookConsentMode === true &&
        enabled.globals.ABconsentCMP.gtmOpenAiConsentMode === true);
    check("new template explicitly delegates both vendor updates to the CMP",
        enabled.globals.ABconsentCMP.gtmFacebookConsentModeUpdatesOwnedByGtm === false &&
        enabled.globals.ABconsentCMP.gtmOpenAiConsentModeUpdatesOwnedByGtm === false);
    check("Google updates are delegated to the CMP when Consent Mode is active",
        enabled.globals.ABconsentCMP.enableConsentMode === true);
    check("Google default handoff is true before the first default is emitted",
        enabled.calls.defaults.length > 0 && enabled.calls.defaultStates[0].googleDefaultSet === true,
        JSON.stringify(enabled.calls.defaultStates));
    const firstState = enabled.calls.injectionStates[0] || {};
    check("overrides, ownership, and handoff are visible at the first /stub injection",
        firstState.facebook === true && firstState.openai === true &&
        firstState.facebookUpdatesOwnedByGtm === false && firstState.openaiUpdatesOwnedByGtm === false &&
        firstState.enableConsentMode === true && firstState.googleDefaultSet === true &&
        firstState.miniStubApis.__tcfapi === true &&
        firstState.miniStubApis.__sdcmpapi === true && firstState.miniStubApis.__uspapi === true &&
        firstState.miniStubApis.__gpp === true, JSON.stringify(firstState));
    const noGoogleRows = run({sddan: SDDAN_LOCAL, data: {
        consentMode: true, settingsTable: [], loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    check("empty Google settings publishes no default handoff",
        noGoogleRows.calls.defaults.length === 0 &&
        noGoogleRows.globals.ABconsentCMP.gtmGoogleConsentModeDefaultSet === undefined &&
        noGoogleRows.calls.injectionStates[0].googleDefaultSet === undefined,
        JSON.stringify(noGoogleRows.calls));
    check("regular loader keeps the real /stub before /cmp",
        enabled.calls.injected.length === 2 && enabled.calls.injected[0].indexOf("/stub") !== -1 &&
        enabled.calls.injected[1].indexOf("/cmp") !== -1, JSON.stringify(enabled.calls.injected));
    check("regular loader completes GTM exactly once", enabled.calls.successes === 1 && enabled.calls.failures === 0,
        JSON.stringify([enabled.calls.successes, enabled.calls.failures]));
    check("Consent Mode update API is not required or called",
        SRC.indexOf("require('updateConsentState')") === -1 && enabled.calls.updates.length === 0);
    check("no consent listener is registered when cookie deletion is disabled", enabled.listener === null);

    const inherited = run({sddan: SDDAN_LOCAL, globals: {ABconsentCMP: {sentinel: true}}, data: {
        consentMode: false, facebookConsentModeOverride: "inherit", openAiConsentModeOverride: "inherit"
    }});
    check("inherit leaves activation and ownership properties absent",
        inherited.globals.ABconsentCMP.gtmFacebookConsentMode === undefined &&
        inherited.globals.ABconsentCMP.gtmOpenAiConsentMode === undefined &&
        inherited.globals.ABconsentCMP.gtmFacebookConsentModeUpdatesOwnedByGtm === undefined &&
        inherited.globals.ABconsentCMP.gtmOpenAiConsentModeUpdatesOwnedByGtm === undefined);
    check("inherit installs no vendor queue", inherited.globals.fbq === undefined && inherited.globals.oaiq === undefined);

    const disabled = run({sddan: SDDAN_LOCAL, data: {
        consentMode: false, facebookConsentModeOverride: "disabled", openAiConsentModeOverride: "disabled"
    }});
    check("disabled publishes false activation and CMP-owned update markers",
        disabled.globals.ABconsentCMP.gtmFacebookConsentMode === false &&
        disabled.globals.ABconsentCMP.gtmOpenAiConsentMode === false &&
        disabled.globals.ABconsentCMP.gtmFacebookConsentModeUpdatesOwnedByGtm === false &&
        disabled.globals.ABconsentCMP.gtmOpenAiConsentModeUpdatesOwnedByGtm === false);
    check("disabled installs no vendor queue", disabled.globals.fbq === undefined && disabled.globals.oaiq === undefined);

    const legacy = run({sddan: SDDAN_LOCAL, globals: {ABconsentCMP: {
        gtmFacebookConsentModeUpdatesOwnedByGtm: true,
        gtmOpenAiConsentModeUpdatesOwnedByGtm: true,
        enableConsentMode: false
    }}, data: {
        facebookConsentModeOverride: "enabled", openAiConsentModeOverride: "enabled",
        loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    check("new template neutralizes legacy ownership values",
        legacy.globals.ABconsentCMP.gtmFacebookConsentModeUpdatesOwnedByGtm === false &&
        legacy.globals.ABconsentCMP.gtmOpenAiConsentModeUpdatesOwnedByGtm === false &&
        legacy.globals.ABconsentCMP.enableConsentMode === true);

    const deletion = run({sddan: SDDAN_LOCAL, data: {
        handleCookiesDeletion: true, loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    check("Sirdata listener remains only for cookie deletion", typeof deletion.listener === "function");
    const beforeUpdates = deletion.calls.updates.length;
    deletion.listener(purgeEvent("_ga"), true);
    check("cookie callback emits no Google update", deletion.calls.updates.length === beforeUpdates);

    const firstParty = run({sddan: SDDAN_LOCAL, data: {
        firstPartyHost: "cmp.example.com", loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    check("first-party loader remains the sole network loader on its success path",
        firstParty.calls.injected.length === 1 && firstParty.calls.injected[0].indexOf("cmp_loader.js") !== -1,
        JSON.stringify(firstParty.calls.injected));
    check("first-party loader completes exactly once", firstParty.calls.successes === 1 && firstParty.calls.failures === 0,
        JSON.stringify([firstParty.calls.successes, firstParty.calls.failures]));

    const fallback = run({sddan: SDDAN_LOCAL, failInjection: "cmp_loader.js", data: {
        firstPartyHost: "cmp.example.com", loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    check("first-party failure falls back to regular /stub then /cmp",
        fallback.calls.injected.length === 3 && fallback.calls.injected[0].indexOf("cmp_loader.js") !== -1 &&
        fallback.calls.injected[1].indexOf("/stub") !== -1 && fallback.calls.injected[2].indexOf("/cmp") !== -1,
        JSON.stringify(fallback.calls.injected));
    check("fallback completes exactly once", fallback.calls.successes === 1 && fallback.calls.failures === 0,
        JSON.stringify([fallback.calls.successes, fallback.calls.failures]));

    const regularFallback = run({sddan: SDDAN_LOCAL, failInjection: "/stub", data: {
        loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    check("regular stub failure still falls back to /cmp exactly once",
        regularFallback.calls.injected.length === 2 && regularFallback.calls.injected[0].indexOf("/stub") !== -1 &&
        regularFallback.calls.injected[1].indexOf("/cmp") !== -1 && regularFallback.calls.successes === 1 &&
        regularFallback.calls.failures === 0, JSON.stringify(regularFallback.calls));

    const cmpFailure = run({sddan: SDDAN_LOCAL, failInjection: "/cmp", data: {
        loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    check("CMP bundle failure reports GTM failure exactly once",
        cmpFailure.calls.successes === 0 && cmpFailure.calls.failures === 1,
        JSON.stringify([cmpFailure.calls.successes, cmpFailure.calls.failures]));
}

console.log("\n22. Early vendor defaults preserve files and callbacks produce no updates");
{
    function beforeOaiq() { beforeOaiq.queue.push(Array.prototype.slice.call(arguments)); }
    beforeOaiq.q = [["consent", false], ["init", {pixelId: "pixel"}], ["pixelId", "pixel"]];
    beforeOaiq.queue = [["consent", "publisher"], ["measure", "page_viewed"], ["set", "user", {id: "user"}]];
    const openai = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.o:1:1"}, globals: {oaiq: beforeOaiq}, data: {
        openAiConsentModeOverride: "enabled", handleCookiesDeletion: true,
        loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    let openAiCommands = commandList(openai.globals.oaiq.queue);
    check("OpenAI unifies q and queue", openai.globals.oaiq.q === openai.globals.oaiq.queue);
    check("OpenAI default comes from stored o segment and filters only consent",
        JSON.stringify(named(openAiCommands, "consent")) === JSON.stringify([["consent", true]]),
        JSON.stringify(openAiCommands));
    check("OpenAI preserves every pending business command in source order",
        JSON.stringify(without(openAiCommands, ["consent"])) === JSON.stringify([
            ["init", {pixelId: "pixel"}], ["pixelId", "pixel"], ["measure", "page_viewed"],
            ["set", "user", {id: "user"}]
        ]), JSON.stringify(openAiCommands));
    openai.globals.oaiq("consent", "third-party");
    openai.globals.oaiq("measure", "after-default");
    openAiCommands = commandList(openai.globals.oaiq.queue);
    check("OpenAI wrapper filters later consent but keeps later business commands",
        named(openAiCommands, "consent").length === 1 &&
        JSON.stringify(openAiCommands[openAiCommands.length - 1]) === JSON.stringify(["measure", "after-default"]));
    const beforeOpenAiCallback = JSON.stringify(openAiCommands);
    openai.listener(TC_ALL_GRANTED, true);
    check("OpenAI callback produces no update", JSON.stringify(commandList(openai.globals.oaiq.queue)) === beforeOpenAiCallback);

    [["2.o:1:0", false], ["2.g:1:1111111", false], ["2.o:1:broken", false]].forEach((fixture) => {
        const result = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": fixture[0]},
            data: {openAiConsentModeOverride: "enabled"}});
        check("OpenAI conservative default " + fixture[0],
            commandList(result.globals.oaiq.queue)[0][1] === fixture[1]);
    });

    function beforeFbq() { beforeFbq.queue.push(Array.prototype.slice.call(arguments)); }
    beforeFbq.queue = [["consent", "publisher"], ["dataProcessingOptions", ["LDU"], 0, 0],
        ["init", "pixel", {em: "hash"}], ["track", "PageView"]];
    beforeFbq.push = beforeFbq;
    const meta = run({sddan: SDDAN_LOCAL, globals: {fbq: beforeFbq, _fbq: beforeFbq}, data: {
        facebookConsentModeOverride: "enabled", handleCookiesDeletion: true,
        loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    let metaCommands = commandList(meta.globals.fbq.queue);
    const temporary = named(metaCommands, "consent").filter((command) => command[2] === "__abconsent_temporary__");
    check("Meta prepends one precisely identifiable conservative temporary default",
        temporary.length === 1 && temporary[0][1] === "revoke" && metaCommands[0][2] === "__abconsent_temporary__",
        JSON.stringify(metaCommands));
    check("Meta publishes the matching temporary marker",
        meta.globals.ABconsentCMP.gtmTemplateFacebookTemporaryRevoke === true);
    check("Meta preserves publisher consent, DPO, init, and track commands",
        JSON.stringify(metaCommands.slice(1)) === JSON.stringify([
            ["consent", "publisher"], ["dataProcessingOptions", ["LDU"], 0, 0],
            ["init", "pixel", {em: "hash"}], ["track", "PageView"]
        ]), JSON.stringify(metaCommands));
    meta.globals.fbq("consent", "after-default");
    meta.globals.fbq("track", "Purchase");
    metaCommands = commandList(meta.globals.fbq.queue);
    check("Meta wrapper preserves later publisher consent and business commands",
        named(metaCommands, "consent").some((command) => command[1] === "after-default") &&
        metaCommands.some((command) => command[0] === "track" && command[1] === "Purchase"));
    const beforeMetaCallback = JSON.stringify(metaCommands);
    meta.listener(TC_ALL_GRANTED, true);
    check("Meta callback produces no update", JSON.stringify(commandList(meta.globals.fbq.queue)) === beforeMetaCallback);

    const initializedOpenAiCalls = [];
    function initializedOaiq() { initializedOpenAiCalls.push(Array.prototype.slice.call(arguments)); }
    const initializedOpenAiQ = [["init", {pixelId: "initialized"}]];
    const initializedOpenAiQueue = [["measure", "queued-before-gtm"]];
    initializedOaiq.q = initializedOpenAiQ;
    initializedOaiq.queue = initializedOpenAiQueue;
    initializedOaiq.__oaiqInitialized = true;
    const initializedOpenAi = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.o:1:1"},
        globals: {oaiq: initializedOaiq}, data: {
            openAiConsentModeOverride: "enabled", handleCookiesDeletion: true,
            loadCmpScripts: true, partnerId: "1020", configId: "public"
        }});
    check("initialized OpenAI SDK function identity is preserved", initializedOpenAi.globals.oaiq === initializedOaiq);
    check("initialized OpenAI q identity is preserved", initializedOpenAi.globals.oaiq.q === initializedOpenAiQ);
    check("initialized OpenAI queue identity is preserved", initializedOpenAi.globals.oaiq.queue === initializedOpenAiQueue);
    check("initialized OpenAI receives the persisted default directly",
        JSON.stringify(initializedOpenAiCalls) === JSON.stringify([["consent", true]]),
        JSON.stringify(initializedOpenAiCalls));
    check("initialized OpenAI business commands are not stranded",
        JSON.stringify(initializedOpenAiQ) === JSON.stringify([["init", {pixelId: "initialized"}]]) &&
        JSON.stringify(initializedOpenAiQueue) === JSON.stringify([["measure", "queued-before-gtm"]]));
    initializedOpenAi.globals.oaiq("measure", "after-default");
    check("initialized OpenAI keeps receiving later business commands",
        JSON.stringify(initializedOpenAiCalls[1]) === JSON.stringify(["measure", "after-default"]),
        JSON.stringify(initializedOpenAiCalls));
    const initializedOpenAiCallsBeforeCallback = JSON.stringify(initializedOpenAiCalls);
    initializedOpenAi.listener(TC_ALL_GRANTED, true);
    check("initialized OpenAI callback emits no update",
        JSON.stringify(initializedOpenAiCalls) === initializedOpenAiCallsBeforeCallback);
    const initializedOpenAiWithoutStoredConsentCalls = [];
    function initializedOaiqWithoutStoredConsent() {
        initializedOpenAiWithoutStoredConsentCalls.push(Array.prototype.slice.call(arguments));
    }
    initializedOaiqWithoutStoredConsent.__oaiqInitialized = true;
    initializedOaiqWithoutStoredConsent.q = [];
    initializedOaiqWithoutStoredConsent.queue = [];
    run({sddan: SDDAN_LOCAL, globals: {oaiq: initializedOaiqWithoutStoredConsent},
        data: {openAiConsentModeOverride: "enabled"}});
    check("initialized OpenAI receives a conservative false default when storage has no decision",
        JSON.stringify(initializedOpenAiWithoutStoredConsentCalls) === JSON.stringify([["consent", false]]),
        JSON.stringify(initializedOpenAiWithoutStoredConsentCalls));

    const initializedMetaCalls = [];
    function initializedFbq() { initializedMetaCalls.push(Array.prototype.slice.call(arguments)); }
    initializedFbq.callMethod = function () {};
    const initializedMetaQueue = [["init", "initialized-pixel"], ["track", "PageView"]];
    initializedFbq.queue = initializedMetaQueue;
    function initializedFbqAlias() {}
    const initializedMetaAliasQueue = [["track", "AliasQueueEvent"]];
    initializedFbqAlias.queue = initializedMetaAliasQueue;
    const initializedMeta = run({sddan: SDDAN_LOCAL, globals: {fbq: initializedFbq, _fbq: initializedFbqAlias}, data: {
        facebookConsentModeOverride: "enabled", handleCookiesDeletion: true,
        loadCmpScripts: true, partnerId: "1020", configId: "public"
    }});
    check("initialized Meta SDK function identity is preserved", initializedMeta.globals.fbq === initializedFbq);
    check("initialized Meta _fbq identity is preserved", initializedMeta.globals._fbq === initializedFbqAlias);
    check("initialized Meta queue identities are preserved",
        initializedMeta.globals.fbq.queue === initializedMetaQueue &&
        initializedMeta.globals._fbq.queue === initializedMetaAliasQueue);
    check("initialized Meta receives the marked temporary revoke directly",
        JSON.stringify(initializedMetaCalls) ===
        JSON.stringify([["consent", "revoke", "__abconsent_temporary__"]]),
        JSON.stringify(initializedMetaCalls));
    check("initialized Meta publishes the temporary revoke handoff marker",
        initializedMeta.globals.ABconsentCMP.gtmTemplateFacebookTemporaryRevoke === true);
    check("initialized Meta business commands are not stranded",
        JSON.stringify(initializedMetaQueue) ===
        JSON.stringify([["init", "initialized-pixel"], ["track", "PageView"]]) &&
        JSON.stringify(initializedMetaAliasQueue) === JSON.stringify([["track", "AliasQueueEvent"]]));
    initializedMeta.globals.fbq("track", "Purchase");
    check("initialized Meta keeps receiving later business commands",
        JSON.stringify(initializedMetaCalls[1]) === JSON.stringify(["track", "Purchase"]),
        JSON.stringify(initializedMetaCalls));
    const initializedMetaCallsBeforeCallback = JSON.stringify(initializedMetaCalls);
    initializedMeta.listener(TC_ALL_GRANTED, true);
    check("initialized Meta callback emits no update",
        JSON.stringify(initializedMetaCalls) === initializedMetaCallsBeforeCallback);
}

// Assertion floor: deleting a test section must fail loudly rather than reporting a vacuous green.
const MIN_CHECKS = 150;
if (checksRun < MIN_CHECKS) {
    failures++;
    console.log("\n  FAIL only " + checksRun + " assertions ran, floor = " + MIN_CHECKS);
}

console.log("\n" + checksRun + " assertions");
console.log(failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
