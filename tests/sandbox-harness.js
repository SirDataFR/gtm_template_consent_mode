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
    ["setDefaultConsentState", "CONSENT_MODE_SIGNALS", "onUserChoice", "loadCmpScript"].forEach((s) => {
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

// Strips comments so the syntax guard below reads CODE and not prose. Without this it reddens on
// the very comment that explains why a construct is avoided -- a check that fails on its own
// documentation, which is worse than no check: the next reader removes the explanation, not the
// cause. It follows quotes because the body carries URLs, and `https://` would otherwise be cut at
// its own `//`; an escaped quote inside a string keeps the string open.
function stripComments(src) {
    let out = "";
    let quote = null;
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (quote) {
            out += c;
            if (c === "\\") { out += src[i + 1] === undefined ? "" : src[i + 1]; i += 2; continue; }
            if (c === quote) { quote = null; }
            i += 1;
            continue;
        }
        if (c === "\"" || c === "'" || c === "`") { quote = c; out += c; i += 1; continue; }
        if (c === "/" && src[i + 1] === "/") {
            while (i < src.length && src[i] !== "\n") { i += 1; }
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            i += 2;
            while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { i += 1; }
            i += 2;
            continue;
        }
        out += c;
        i += 1;
    }
    return out;
}

// The stripper decides what the guard sees, so it is pinned before being trusted: a false positive
// here rejects a valid template, a false negative lets a forbidden construct through.
[
    ["a line comment goes", "var a = 1; // arguments\n", false],
    ["a block comment goes", "var a = 1; /* arguments */ var b = 2;", false],
    ["a URL survives its own slashes", "var u = 'https://x/arguments';", true],
    ["an escaped quote keeps the string open", "var s = 'a\\' // arguments'; var t = 1;", true],
    ["real code is kept", "fn(arguments);", true]
].forEach((c) => {
    const seen = /(^|[^A-Za-z_$])arguments([^A-Za-z0-9_$]|$)/.test(stripComments(c[1]));
    if (seen !== c[2]) {
        throw new Error("stripComments is unreliable: " + c[0] + " -> " + seen);
    }
});

function assertGtmSandboxSubset(src) {
    const code = stripComments(src);
    const forbidden = [
        ["try/catch", /(^|[^A-Za-z_$])(try|catch)([^A-Za-z0-9_$]|$)/],
        ["bare arguments", /(^|[^A-Za-z_$])arguments([^A-Za-z0-9_$]|$)/]
    ];
    forbidden.forEach((entry) => {
        if (entry[1].test(code)) {
            throw new Error("GTM sandbox subset forbids " + entry[0]);
        }
    });
}
assertGtmSandboxSubset(SRC);

function extractJsonSection(open, close) {
    const afterOpen = TPL.split(open);
    if (afterOpen.length !== 2 || afterOpen[1].indexOf(close) === -1) {
        throw new Error("cannot extract " + open);
    }
    return afterOpen[1].split(close)[0].trim();
}

function run(opts) {
    const cookies = Object.assign({}, opts.cookies || {});
    // `cookieReads` counts reads PER NAME. Without it a short-circuit can only be checked on the
    // value it produces, and an implementation that reads the container and then overwrites the
    // result would pass while consulting a cookie it must never touch.
    const calls = {defaults: [], defaultStates: [], updates: [], setCookies: [], injected: [], injectionStates: [], cookieReads: {}, successes: 0, failures: 0, listenerAfterInjections: null};
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
                // How many requests had already gone out when the listener was registered. The
                // queue is installed by this tag, so the command can wait in it -- but only if it
                // is issued before the CMP is asked for.
                if (calls.listenerAfterInjections === null) { calls.listenerAfterInjections = calls.injected.length; }
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
        getCookieValues: (name) => {
            calls.cookieReads[name] = (calls.cookieReads[name] || 0) + 1;
            return cookies[name] === undefined ? [] : [cookies[name]];
        },
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
        createArgumentsQueue: (fnKey, arrayKey) => {
            let queue = getPath(arrayKey);
            if (!Array.isArray(queue)) queue = [];
            let fn = getPath(fnKey);
            if (typeof fn !== "function") {
                fn = function () {
                    queue.push(Array.prototype.slice.call(arguments));
                };
                setPath(fnKey, fn, true);
            }
            if (!Array.isArray(getPath(arrayKey))) setPath(arrayKey, queue, true);
            return fn;
        },
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

// Declaring rows is an OVERRIDE: the two travel together, because rows alone read as "left the
// defaults alone" and the run would silently exercise the automatic path instead of the case.
const withRows = (rows) => ({overrideDefaultConsent: true, customConsentSettings: rows});

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
    check("two defaults set: the regulated perimeter, then the global one",
        r.calls.defaults.length === 2 && r.calls.defaults[0].region &&
        r.calls.defaults[1].region === undefined,
        JSON.stringify(r.calls.defaults.map((d) => d.region)));
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
    check("witness -- it still pushes its defaults but no update",
        temoin.calls.defaults.length === 2 && temoin.calls.updates.length === 0);
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
    const GRANTED = withRows([ALL_GRANTED_ROW]);
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

console.log("\n14. The marker SHORT-CIRCUITS the default: nothing else is consulted");
{
    // A row granting EVERYTHING, for the same reason as section 13: against an all-denied table a
    // denial would be indistinguishable from the configured value.
    const ALL_GRANTED_ROW = {
        ad_storage: "granted", analytics_storage: "granted", personalization_storage: "granted",
        functionality_storage: "granted", security_storage: "granted",
        wait_for_update: 1000, region: "ALL"
    };
    const GRANTED = withRows([ALL_GRANTED_ROW]);
    const readsOf = (r, name) => (r.calls.cookieReads[name] || 0);

    // Witness: WITHOUT the marker the container IS read. Without it, the count asserted below
    // would also be satisfied by a harness that reads no cookie at all, or by a template that
    // stopped reading `__sdgcm` entirely -- a check that cannot fail checks nothing.
    const temoin = run({sddan: SDDAN_LOCAL, data: GRANTED, cookies: {"__sdgcm": "2.g:1:1111111"}});
    check("witness -- without the marker the container IS read",
        readsOf(temoin, "__sdgcm") >= 1, String(readsOf(temoin, "__sdgcm")));

    // THE short-circuit, pinned on the READ rather than on the result. An implementation that
    // reads the container and then overwrites what it found emits exactly the same values while
    // consulting a cookie that must never be consulted; only the count separates the two.
    const court = run({sddan: SDDAN_LOCAL, data: GRANTED, cookies: {"__gpcactive": "1"}});
    check("the container is NOT consulted when the marker is present",
        readsOf(court, "__sdgcm") === 0, String(readsOf(court, "__sdgcm")));
    check("the marker itself is still read", readsOf(court, "__gpcactive") >= 1,
        String(readsOf(court, "__gpcactive")));
    const c = court.calls.defaults[0];
    check("short-circuit denies the five signals an objection covers",
        c.ad_storage === "denied" && c.ad_user_data === "denied" &&
        c.ad_personalization === "denied" && c.analytics_storage === "denied" &&
        c.personalization_storage === "denied", JSON.stringify(c));
    // FIVE, not seven: an objection to sale and sharing is not a refusal of what is strictly
    // necessary. Moving the denial to the head of the chain must not change which signals it
    // covers -- only when it is decided.
    check("and leaves the two strictly-necessary signals alone",
        c.functionality_storage === "granted" && c.security_storage === "granted",
        JSON.stringify(c));
    check("nothing left to wait for", c.wait_for_update === 0, JSON.stringify(c));

    // Same short-circuit, with a container that would grant EVERYTHING. This is the case where a
    // post-hoc implementation and a short-circuit diverge on the read while agreeing on the value.
    const contre = run({
        sddan: SDDAN_LOCAL, data: GRANTED,
        cookies: {"__gpcactive": "1", "__sdgcm": "2.g:1:1111111", "euconsent-v2": "x"}
    });
    check("an all-granting container is not even read",
        readsOf(contre, "__sdgcm") === 0, String(readsOf(contre, "__sdgcm")));
    check("and the result stays denied",
        contre.calls.defaults[0].ad_storage === "denied" &&
        contre.calls.defaults[0].analytics_storage === "denied", JSON.stringify(contre.calls.defaults[0]));

    // Marker ABSENT, container present: the second branch keeps behaving exactly as before. The
    // bits are mixed on purpose -- an all-granted or all-denied string would pass against a
    // template that ignored the container altogether.
    const stocke = run({sddan: SDDAN_LOCAL, data: GRANTED, cookies: {"__sdgcm": "2.g:1:1010000"}});
    const s = stocke.calls.defaults[0];
    check("without the marker the container is read", readsOf(stocke, "__sdgcm") >= 1,
        String(readsOf(stocke, "__sdgcm")));
    check("stored signals still drive the default, signal by signal",
        s.analytics_storage === "granted" && s.functionality_storage === "denied" &&
        s.security_storage === "granted" && s.personalization_storage === "denied" &&
        s.ad_storage === "denied", JSON.stringify(s));
    check("a known choice leaves nothing to wait for", s.wait_for_update === 0, JSON.stringify(s));

    // Third branch: neither marker nor container, so nothing was ever recorded -- and the row is
    // emitted AS WRITTEN. There used to be a US perimeter test here that forced the five signals
    // to denied; it overrode a publisher who had stated a value for their own perimeter, so it is
    // gone. A declared table is applied as declared.
    const US_ROW = Object.assign({}, ALL_GRANTED_ROW, {region: "US-CA"});
    const us = run({sddan: SDDAN_LOCAL, data: withRows([US_ROW])});
    const u = us.calls.defaults[0];
    check("a declared US row is applied as declared, not overridden",
        u.ad_storage === "granted" && u.analytics_storage === "granted" &&
        u.personalization_storage === "granted", JSON.stringify(u));
    check("including the strictly-necessary signals",
        u.functionality_storage === "granted" && u.security_storage === "granted",
        JSON.stringify(u));
    // Still a default awaiting a choice, so there is still something to wait for.
    check("and its wait_for_update is preserved", u.wait_for_update === 1000, JSON.stringify(u));
    check("and its region is still carried",
        JSON.stringify(u.region) === JSON.stringify(["US-CA"]), JSON.stringify(u.region));

    // The plain country value is treated no differently: no region is special to this branch.
    const usPlain = run({sddan: SDDAN_LOCAL,
        data: withRows([Object.assign({}, ALL_GRANTED_ROW, {region: "US"})])});
    check("the plain country value is not special either",
        usPlain.calls.defaults[0].ad_storage === "granted",
        JSON.stringify(usPlain.calls.defaults[0]));
    // AUTOMATIC mode is where the US denial lives, and it is carried by the perimeter row rather
    // than by a test: `US` sits in the regional list, which is all-denied.
    const auto = run({sddan: SDDAN_LOCAL});
    check("AUTO: the US is denied, by the perimeter row",
        auto.calls.defaults[0].region.indexOf("US") >= 0 &&
        auto.calls.defaults[0].ad_storage === "denied" &&
        auto.calls.defaults[0].analytics_storage === "denied",
        JSON.stringify(auto.calls.defaults[0]));

    // Outside that perimeter NOTHING changes: the configured regional default stands. Without
    // this the US rule above would be satisfied by a template denying everything everywhere.
    const fr = run({sddan: SDDAN_LOCAL,
        data: withRows([Object.assign({}, ALL_GRANTED_ROW, {region: "FR"})])});
    const f = fr.calls.defaults[0];
    check("outside the US perimeter the configured default is untouched",
        f.ad_storage === "granted" && f.analytics_storage === "granted" &&
        f.personalization_storage === "granted", JSON.stringify(f));
    check("outside the US perimeter wait_for_update is untouched", f.wait_for_update === 1000,
        JSON.stringify(f));
    // `US` must match the perimeter, `USA`-like neighbours must not: the prefix is a perimeter,
    // not a substring match.
    const ru = run({sddan: SDDAN_LOCAL,
        data: withRows([Object.assign({}, ALL_GRANTED_ROW, {region: "RU"})])});
    check("a region merely containing the letters is not the US perimeter",
        ru.calls.defaults[0].ad_storage === "granted", JSON.stringify(ru.calls.defaults[0]));
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

    // The two above were the only exempt names pinned, and the list has six. The one that mattered
    // most was not among them: the container this template READS for its default. Deleting it would
    // erase the very choice the default replays, on the page view where the visitor has just
    // refused -- and the sweep matches by name over everything on the page, so a name missing from
    // the exempt list is deleted in silence.
    //
    // The names are READ FROM THE SOURCE rather than written here. A list written twice diverges,
    // and the half that diverges is the one nobody re-reads.
    const exemptSource = stripComments(SRC).split("exemptedCookiesNames = [")[1];
    if (exemptSource === undefined) { throw new Error("the exempt cookie list was not found"); }
    const exemptNames = (exemptSource.split("]")[0].match(/'[^']+'/g) || [])
        .map((quoted) => quoted.slice(1, -1));
    check("the exempt list was read from the source", exemptNames.length >= 6, exemptNames.join(","));

    const everyCookie = {};
    exemptNames.forEach((name) => { everyCookie[name] = "1"; });
    everyCookie._ga = "1";
    const sweep = run({sddan: SDDAN_LOCAL, data: {handleCookiesDeletion: true}, cookies: everyCookie});
    sweep.listener(purgeEvent(exemptNames.concat(["_ga"]).join(",")), true);
    const swept = deletedNames(sweep.calls);
    // Witness first: without a cookie actually being deleted, the loop below holds on an empty
    // sweep and every exempt name passes for the wrong reason.
    check("the sweep ran", swept.indexOf("_ga") !== -1, JSON.stringify(swept));
    exemptNames.forEach((name) => {
        check(name + " survives the sweep", swept.indexOf(name) === -1, JSON.stringify(swept));
    });

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
    const CMP = Object.assign(withRows([ROW]), {partnerId: "1020", configId: "hmDnl"});

    const sans = run({sddan: SDDAN_LOCAL, data: CMP});
    const avec = run({sddan: SDDAN_LOCAL, data: CMP, cookies: {"__gpcactive": "1"}});

    // Witness: without it, a harness injecting NOTHING would satisfy the equality below.
    check("witness -- one script injected without the marker", sans.calls.injected.length === 1,
        JSON.stringify(sans.calls.injected));
    check("witness -- and it is the bundle",
        sans.calls.injected[0].indexOf("/cmp") !== -1,
        JSON.stringify(sans.calls.injected));

    check("the marker removes no script", avec.calls.injected.length === 1,
        JSON.stringify(avec.calls.injected));
    check("and they are exactly the same URLs",
        JSON.stringify(avec.calls.injected) === JSON.stringify(sans.calls.injected),
        JSON.stringify(avec.calls.injected));

    // The discriminator: without it, the equality above would also be satisfied by an INERT GPC,
    // that is, by a marker doing nothing at all.
    check("while the status itself does change",
        sans.calls.defaults[0].ad_storage === "granted" && avec.calls.defaults[0].ad_storage === "denied",
        JSON.stringify([sans.calls.defaults[0].ad_storage, avec.calls.defaults[0].ad_storage]));
    check("and loading is unchanged when the identifiers are missing",
        run({sddan: SDDAN_LOCAL, data: withRows([ROW]), cookies: {"__gpcactive": "1"}})
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
    const info = JSON.parse(extractJsonSection("___INFO___", "___VENDOR_DETAILS___"));
    const currentVersionMatch = SRC.match(/const currentVersion = '([^']+)';/);
    check("___INFO___ version matches the sandbox currentVersion",
        currentVersionMatch !== null && String(info.version) === currentVersionMatch[1],
        JSON.stringify({infoVersion: info.version, currentVersion: currentVersionMatch && currentVersionMatch[1]}));

    const parameters = JSON.parse(extractJsonSection(
        "___TEMPLATE_PARAMETERS___", "___SANDBOXED_JS_FOR_WEB_TEMPLATE___"));
    const flatten = (params) => params.reduce((all, param) =>
        all.concat([param], flatten(param.subParams || [])), []);
    const byName = (name) => flatten(parameters).filter((param) => param.name === name)[0];

    // The form asks for the CMP first and shows nothing else until it has an answer. The two
    // identifiers are therefore TOP-LEVEL fields rather than members of a section: a condition
    // naming a field buried inside another section is the one shape no shipped template uses, and
    // the shape this form was measured getting wrong in the real editor.
    const topLevel = parameters.map((param) => param.name);
    check("the form opens on the CMP identifiers, then the three consent modes",
        JSON.stringify(topLevel) === JSON.stringify(["cmpSection", "partnerId", "configId",
            "firstPartyHost", "consent Mode", "facebookConsentModeGroup",
            "openAiConsentModeGroup", "Cookies"]), JSON.stringify(topLevel));
    const gatedOnCmp = (param) => JSON.stringify((param.enablingConditions || []).map((condition) =>
        [condition.paramName, condition.type, condition.paramValue])) ===
        JSON.stringify([["configId", "NOT_EQUALS", ""]]);
    check("every section below the identifiers waits for the configuration id",
        parameters.slice(4).every(gatedOnCmp) && parameters.slice(0, 4).every((param) =>
            param.enablingConditions === undefined),
        JSON.stringify(parameters.map((param) => [param.name, gatedOnCmp(param)])));

    // ONE condition per field, everywhere. Multiple conditions are read as "any of these", not
    // "all of these" -- which is how a table that asked for the activation AND the override went
    // on showing with only the activation ticked. A second condition is therefore never a
    // narrowing; it is a widening, and the field it widens is the one nobody re-reads.
    const multiGated = flatten(parameters).filter((param) =>
        (param.enablingConditions || []).length > 1);
    check("no field carries more than one enabling condition",
        multiGated.length === 0, JSON.stringify(multiGated.map((param) =>
            [param.name, (param.enablingConditions || []).length])));

    // And the condition must name a SIBLING -- a field declared at the same level, in the same
    // list. That is what every working gate in this file does, and the one that did not was the
    // measured symptom: a table that went on showing because its gate named a field one level up.
    //
    // The cookie exception table carried the same shape, and its own group already gated it from
    // the right level, so its condition could only be redundant or non-resolving. It is removed
    // rather than left to be discovered a second time: whichever of the two it was, the field is
    // hidden by its group exactly as before.
    const crossLevel = [];
    (function walkLevels(list) {
        const siblings = list.filter((param) => param.name).map((param) => param.name);
        list.forEach((param) => {
            (param.enablingConditions || []).forEach((condition) => {
                if (siblings.indexOf(condition.paramName) === -1) {
                    crossLevel.push(param.name + " -> " + condition.paramName);
                }
            });
            ["subParams", "parameters"].forEach((key) => {
                if (param[key]) { walkLevels(param[key]); }
            });
        });
    })(parameters);
    check("every enabling condition names a field at its own level",
        crossLevel.length === 0, crossLevel.join(" | "));

    // Witness: conditions exist at all. Without it, a tree that lost every gate would satisfy the
    // two checks above by having nothing to check.
    const gateCount = flatten(parameters).reduce((n, param) =>
        n + ((param.enablingConditions || []).length), 0);
    check("the form still carries its gates", gateCount >= 8, String(gateCount));

    // Each vendor has its own section, at the level of Google's, and carries the link to the
    // official template it coordinates with -- a single shared section could only name both.
    const VENDOR_SECTIONS = [
        ["facebookConsentModeGroup", "Facebook Consent Mode", "facebookConsentMode",
            "Activate Facebook Consent Mode",
            "https://github.com/facebook/GoogleTagManager-WebTemplate-For-FacebookPixel"],
        ["openAiConsentModeGroup", "OpenAI/GPT Ads Consent Mode", "openAiConsentMode",
            "Activate OpenAI/GPT Ads Consent Mode",
            "https://github.com/openai/ads-measurement-pixel-gtm-template"]];
    const selectors = VENDOR_SECTIONS.map((section) => byName(section[2]));
    VENDOR_SECTIONS.forEach((section) => {
        const vendorGroup = byName(section[0]) || {};
        const selector = byName(section[2]) || {};
        check("the " + section[1] + " section is named like Google's and links its template",
            vendorGroup.type === "GROUP" && vendorGroup.displayName === section[1] &&
            (vendorGroup.help || "").indexOf(section[4]) !== -1 &&
            selector.checkboxText === section[3],
            JSON.stringify([vendorGroup.displayName, selector.checkboxText]));
    });
    check("both vendor settings are binary checkboxes that default to off",
        selectors.length === 2 && selectors.every((selector) =>
            selector && selector.type === "CHECKBOX" && selector.defaultValue === false &&
            selector.selectItems === undefined),
        JSON.stringify(selectors.map((selector) => selector &&
            [selector.name, selector.type, selector.defaultValue])));

    // The page-level settings are binary BY DESIGN, and this guard is what keeps them so. A third
    // "inherit the CMP configuration" state is not a nicety this tag chose to skip: it runs before
    // any CMP script, so there is no configuration for it to read, and it is itself the one
    // preparing these defaults. A selector reintroduced on either brings back a state nothing can
    // honour. They are found by name anywhere in the parameter tree, so moving one between groups
    // does not quietly drop it from this check.
    const PAGE_LEVEL = ["facebookConsentMode", "openAiConsentMode"];
    const pageLevel = flatten(parameters).filter((param) => PAGE_LEVEL.indexOf(param.name) !== -1);
    check("the page-level settings exist and neither is a selector",
        pageLevel.length === PAGE_LEVEL.length && pageLevel.every((param) =>
            param.type === "CHECKBOX" && param.defaultValue === false &&
            param.selectItems === undefined),
        JSON.stringify(pageLevel.map((param) => [param.name, param.type, param.defaultValue])));

    // The US regulation scope is NOT a template setting, and its absence is load-bearing: this tag
    // never acts on it -- it cannot know the visitor's state -- so exposing it would have been a
    // pure pass-through whose only effect was to override the CMP from a page with no opinion.
    // An unchecked box would then have silently narrowed a scope the publisher had widened.
    const scopeParams = flatten(parameters).filter((param) =>
        String(param.name || "").toLowerCase().indexOf("allstates") !== -1);
    check("no parameter offers the US regulation scope", scopeParams.length === 0,
        JSON.stringify(scopeParams.map((param) => param.name)));
    check("the sandboxed body publishes no US scope property",
        SRC.indexOf("gtmCcpaApplyToAllStates") === -1);

    // Loading the CMP is no longer a choice, and its absence is load-bearing twice over: this tag
    // prepares the defaults that only the CMP can then resolve, and it installs the mini-stubs the
    // CMP takes over. A box that skipped the load would leave both half-done -- defaults posted
    // with nobody to update them, queues with nobody to drain them.
    const skipParams = flatten(parameters).filter((param) =>
        String(param.name || "").toLowerCase().indexOf("loadcmp") !== -1);
    check("no parameter offers to skip loading the CMP", skipParams.length === 0,
        JSON.stringify(skipParams.map((param) => param.name)));
    check("the sandboxed body reads no such setting", SRC.indexOf("loadCmpScripts") === -1);
    // Required, and unconditionally shown: a field revealed by a condition that no longer exists
    // is a field nobody can fill.
    const IDENTIFIERS = ["partnerId", "configId"];
    const identifiers = flatten(parameters).filter((param) => IDENTIFIERS.indexOf(param.name) !== -1);
    check("both CMP identifiers are unconditional and non-empty",
        identifiers.length === IDENTIFIERS.length && identifiers.every((param) =>
            param.enablingConditions === undefined &&
            (param.valueValidators || []).some((validator) => validator.type === "NON_EMPTY")),
        JSON.stringify(identifiers.map((param) =>
            [param.name, param.enablingConditions !== undefined,
             (param.valueValidators || []).map((validator) => validator.type)])));

    // The fine-grained area is an OVERRIDE of the automatic default state, so it hangs off a box
    // that starts unchecked -- which is what makes a container saved against an earlier version
    // fall back to the automatic path.
    const override = byName("overrideDefaultConsent");
    check("the override is a checkbox that starts unchecked",
        override !== undefined && override.type === "CHECKBOX" && override.defaultValue === false,
        JSON.stringify(override && [override.type, override.defaultValue]));
    const gatedOn = (param) => ((param || {}).enablingConditions || []).map((condition) =>
        condition.paramName + "=" + condition.paramValue).sort().join(",");
    check("the override hangs off the activation, at its own level",
        gatedOn(override) === "consentMode=true" &&
        (byName("consent Mode").subParams || []).some((param) => param.name === "consentMode"),
        gatedOn(override));
    // The table IS the fine-grained area now. The group that used to wrap it carried the heading
    // and the condition, and could gate neither: a section cannot hide itself, and the condition
    // it handed down named a field one level above the table's own. The table carries the heading
    // and one condition naming its own neighbour, which is the shape the shipped templates use.
    check("the fine-grained table is gated on the override alone, beside it",
        gatedOn(byName("customConsentSettings")) === "overrideDefaultConsent=true" &&
        byName("defaultSettings") === undefined &&
        (byName("consent Mode").subParams || []).some((param) =>
            param.name === "customConsentSettings"),
        JSON.stringify([gatedOn(byName("customConsentSettings")),
            byName("defaultSettings") !== undefined]));
    // An empty table is a legitimate state rather than a mistake, and the body already treats it
    // as one: the override falls back to the automatic default state when no rule is declared,
    // which the behaviour run below exercises. An editor rule demanding a row would refuse to save
    // exactly that container -- a publisher who checks the box, looks at the rules, and decides the
    // automatic state was right after all would be stuck with a form they cannot leave.
    const table = byName("customConsentSettings");
    check("the fine-grained table demands no row",
        table !== undefined && (table.valueValidators || []).length === 0,
        JSON.stringify(table && (table.valueValidators || []).map((validator) => validator.type)));
    // The table was RENAMED so rows saved against an earlier version are dropped rather than
    // replayed unreviewed. The old name coming back would silently carry them over again.
    check("the earlier table name is gone from the parameters and the body",
        flatten(parameters).every((param) => param.name !== "settingsTable") &&
        SRC.indexOf("data.settingsTable") === -1);
    check("the fine-grained area keeps its name in the interface",
        table !== undefined && table.displayName === "Default Consent Mode Settings",
        JSON.stringify(table && table.displayName));

    const uiCopy = VENDOR_SECTIONS.map((section) => {
        const vendorGroup = byName(section[0]) || {};
        const selector = byName(section[2]) || {};
        return [vendorGroup.displayName, vendorGroup.help,
            selector.checkboxText, selector.help].join(" ");
    }).join(" ");
    check("wording describes the prepared default and CMP-owned updates",
        uiCopy.indexOf("default") !== -1 &&
        uiCopy.indexOf("the CMP sends every subsequent update") !== -1, uiCopy);
    check("wording states that the CMP configuration is not consulted",
        uiCopy.indexOf("the CMP configuration is not read") !== -1, uiCopy);
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
    // Every entry must carry the NUMERIC type code GTM serializes maps with -- 3, not the string
    // "MAP". Two entries shipped with the string form and nothing here saw it: this block parses
    // mapKey/mapValue and never looked at the item's own type, so a shape the editor may refuse
    // was invisible to a green harness.
    globalItems.forEach((item) => {
        const key = (item.mapValue && item.mapValue[0] && item.mapValue[0].string) || "?";
        check("access_globals entry " + key + " carries the numeric map type",
            item.type === 3, JSON.stringify(item.type));
    });
    // And nothing may be declared that the sandboxed code never touches: an unused permission is
    // access granted for nothing. `SDDAN` was declared readable and never read.
    const sandboxed = SRC;
    rows.forEach((row) => {
        const root = row[0].split(".")[0];
        check("access_globals entry " + row[0] + " is actually reached by the code",
            sandboxed.indexOf(root) !== -1, row[0]);
    });
    ["__tcfapi", "__sdcmpapi", "__uspapi", "__gpp", "__gpp.queue", "__gpp.events",
        "fbq", "fbq.queue", "fbq.queue.push", "fbq.push", "_fbq",
        "oaiq", "oaiq.q", "oaiq.queue", "oaiq.queue.push",
        "oaiq.queue.__sdSharedStorage", "oaiq.q.__sdSharedStorage"].forEach((key) => {
        check("access_globals includes " + key, rows.some((row) => row[0] === key), JSON.stringify(rows));
    });
    // The shared-storage question is asked for OpenAI ONLY. Meta reads its canonical list alone,
    // because a distinct `_fbq.queue` belongs to another advertiser's pixel rather than to a second
    // copy of this one's pending work.
    const probeCalls = Array.from(SRC.matchAll(/queuesShareStorage\('([^']+)',\s*'([^']+)'\)/g));
    check("the shared-storage question is asked once, for OpenAI", probeCalls.length === 1 &&
        probeCalls[0][1] === "oaiq.queue" && probeCalls[0][2] === "oaiq.q",
        JSON.stringify(probeCalls.map((match) => [match[1], match[2]])));
    // The mark is a named property written and read back, so what it needs is read/write on two
    // exact paths -- and crucially NO execute anywhere: an execute permission would be the sign
    // that a publisher-supplied method is being called again.
    probeCalls.forEach((match) => {
        const written = match[1] + ".__sdSharedStorage";
        const observed = match[2] + ".__sdSharedStorage";
        check("the mark is writable on " + written,
            rows.some((row) => row[0] === written && row[1] === true && row[2] === true && row[3] === false),
            JSON.stringify(rows));
        check("the mark is readable on " + observed,
            rows.some((row) => row[0] === observed && row[1] === true && row[3] === false),
            JSON.stringify(rows));
    });
    check("no queue method carries an execute permission",
        !rows.some((row) => /\.(push|splice)$/.test(row[0]) && row[3] === true &&
            row[0] !== "fbq.queue.push" && row[0] !== "oaiq.queue.push" &&
            // OUR OWN list, not a publisher's: the consent namespace is created by this template or
            // by the consent script, never supplied by the page. The rule this guard enforces is
            // about calling back into a method the PUBLISHER put there.
            row[0] !== "ABconsentCMP.openai.preQueue.push"), JSON.stringify(rows));
    check("the removed check leaves no permission behind",
        !rows.some((row) => row[0] === "fbq.queue.splice" || row[0] === "oaiq.queue.splice" ||
            row[0] === "_fbq.queue"), JSON.stringify(rows));
    // The sentinel concept is gone entirely, so "no sentinel is ever published" holds by
    // construction rather than by filtering it back out of the rebuilt queues.
    check("no sentinel value is written into a queue at all",
        SRC.indexOf("QUEUE_STORAGE_PROBE") === -1 && SRC.indexOf("__sd_queue_storage_probe__") === -1);
    check("no publisher queue method is ever called",
        SRC.indexOf("'.push'") === -1 && SRC.indexOf("'.splice'") === -1, SRC.indexOf("'.splice'"));
    check("initialized SDK detection permissions stay minimal",
        rows.some((row) => row[0] === "fbq.callMethod" && row[1] === true && row[2] === false && row[3] === false) &&
        rows.some((row) => row[0] === "oaiq.__oaiqInitialized" && row[1] === true && row[2] === false && row[3] === false),
        JSON.stringify(rows));
    check("the Meta globals stay exact read/write paths",
        rows.some((row) => row[0] === "fbq" && row[1] === true && row[2] === true) &&
        rows.some((row) => row[0] === "fbq.queue" && row[1] === true && row[2] === true),
        JSON.stringify(rows));
    // This assertion said the opposite until the routing was fixed: it pinned the ABSENCE of this
    // permission, which is what a queue that only ever appends needs. The permission is now what
    // lets the installed function hand a call to the SDK, so its absence is the defect.
    check("the installed function may hand a call to the SDK",
        rows.some((row) => row[0] === "fbq.callMethod.apply" && row[1] === true && row[3] === true),
        JSON.stringify(rows));
    check("no vendor SDK domain was added to inject_script",
        permissionsText.indexOf("connect.facebook.net") === -1 && permissionsText.indexOf("bzrcdn.openai.com") === -1);
    check("template creates no locator iframe or message listener",
        SRC.indexOf("Locator") === -1 && SRC.indexOf("postMessage") === -1 && SRC.indexOf("addEventListener('message'") === -1);
}

console.log("\n20. Same-window mini-stubs and takeover handoff");
{
    const thirdPartyUsp = function () { return "publisher"; };
    const valid = run({sddan: SDDAN_LOCAL, globals: {__uspapi: thirdPartyUsp}, data: {
        partnerId: "1020", configId: "public"
    }});
    check("valid loader configuration installs missing mini-stubs",
        typeof valid.globals.__tcfapi === "function" && typeof valid.globals.__sdcmpapi === "function" &&
        typeof valid.globals.__gpp === "function");
    check("pre-existing third-party CMP API is never replaced", valid.globals.__uspapi === thirdPartyUsp);
    check("handoff marks only APIs actually installed by the template",
        JSON.stringify(valid.globals.ABconsentCMP.gtmTemplateMiniStubApis) ===
        JSON.stringify({__tcfapi: true, __sdcmpapi: true, __gpp: true}),
        JSON.stringify(valid.globals.ABconsentCMP.gtmTemplateMiniStubApis));

    const tcfArgs = ["getTCData", 2, function () {}];
    if (typeof valid.globals.__tcfapi === "function") valid.globals.__tcfapi.apply(null, tcfArgs);
    const tcfQueue = typeof valid.globals.__tcfapi === "function" ? valid.globals.__tcfapi() : [];
    check("TCF no-command call returns its recoverable queue",
        tcfQueue === valid.globals.__tcfapi() && tcfQueue.length === 1);
    check("TCF queue preserves every named argument", tcfQueue[0] && tcfQueue[0].length === 3 &&
        tcfQueue[0][0] === tcfArgs[0] && tcfQueue[0][2] === tcfArgs[2]);
    if (typeof valid.globals.__tcfapi === "function") {
        valid.globals.__tcfapi("removeEventListener", 2, function () {}, 42);
    }
    check("TCF queue preserves the optional parameter without padding calls that omit it",
        tcfQueue[0] && tcfQueue[0].length === 3 &&
        tcfQueue[1] && tcfQueue[1].length === 4 && tcfQueue[1][3] === 42,
        JSON.stringify(tcfQueue));
    let tcfPing = null;
    if (typeof valid.globals.__tcfapi === "function") valid.globals.__tcfapi("ping", 2, (value, ok) => { tcfPing = [value, ok]; });
    check("TCF ping reports a pending stub", tcfPing && tcfPing[1] === true &&
        tcfPing[0].cmpLoaded === false && tcfPing[0].cmpStatus === "stub" && tcfPing[0].gdprApplies === undefined,
        JSON.stringify(tcfPing));

    const sdArgs = ["getConfig", 2, function () {}];
    if (typeof valid.globals.__sdcmpapi === "function") valid.globals.__sdcmpapi.apply(null, sdArgs);
    const sdQueue = typeof valid.globals.__sdcmpapi === "function" ? valid.globals.__sdcmpapi() : [];
    check("Sirdata API queue is recoverable and preserves every named argument",
        sdQueue === valid.globals.__sdcmpapi() && sdQueue.length === 1 &&
        sdQueue[0].length === 3 && sdQueue[0][2] === sdArgs[2]);
    if (typeof valid.globals.__sdcmpapi === "function") {
        valid.globals.__sdcmpapi("removeEventListener", 2, function () {}, 42);
    }
    check("Sirdata API queue preserves the optional parameter without padding calls that omit it",
        sdQueue[0] && sdQueue[0].length === 3 &&
        sdQueue[1] && sdQueue[1].length === 4 && sdQueue[1][3] === 42,
        JSON.stringify(sdQueue));

    const usp = run({sddan: SDDAN_LOCAL, data: {partnerId: "1020", configId: "public"}});
    const uspArgs = ["getUSPData", 1, function () {}];
    if (typeof usp.globals.__uspapi === "function") usp.globals.__uspapi.apply(null, uspArgs);
    const uspQueue = typeof usp.globals.__uspapi === "function" ? usp.globals.__uspapi() : [];
    check("USP queue is recoverable and preserves every named argument",
        uspQueue.length === 1 && uspQueue[0].length === 3 && uspQueue[0][2] === uspArgs[2]);
    if (typeof usp.globals.__uspapi === "function") {
        usp.globals.__uspapi("removeEventListener", 1, function () {}, 42);
    }
    check("USP queue preserves the optional parameter without padding calls that omit it",
        uspQueue[0] && uspQueue[0].length === 3 &&
        uspQueue[1] && uspQueue[1].length === 4 && uspQueue[1][3] === 42,
        JSON.stringify(uspQueue));
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
    const replayed = [];
    function replayTarget() {
        replayed.push(Array.prototype.slice.call(arguments));
    }
    [tcfQueue[0], uspQueue[0], valid.globals.__gpp.queue[0]].forEach((queuedCall) => {
        if (queuedCall) replayTarget.apply(null, queuedCall);
    });
    check("mini-stub queues use arrays replayable via apply",
        Array.isArray(tcfQueue[0]) && Array.isArray(uspQueue[0]) &&
        Array.isArray(valid.globals.__gpp.queue[0]) && replayed.length === 3 &&
        replayed[0][0] === "getTCData" && replayed[1][0] === "getUSPData" &&
        replayed[2][0] === "getGPPData", JSON.stringify(replayed.map((entry) => entry[0])));

    const noConfig = run({sddan: SDDAN_LOCAL, data: {partnerId: "1020"}});
    check("mini-stubs are absent when the configuration identifier is missing",
        noConfig.globals.__tcfapi === undefined && noConfig.globals.__sdcmpapi === undefined &&
        noConfig.globals.__uspapi === undefined && noConfig.globals.__gpp === undefined);
    const noPartner = run({sddan: SDDAN_LOCAL, data: {configId: "public"}});
    check("mini-stubs are absent when the partner identifier is missing",
        noPartner.globals.__tcfapi === undefined && noPartner.globals.__sdcmpapi === undefined &&
        noPartner.globals.__uspapi === undefined && noPartner.globals.__gpp === undefined);

    function thirdPartyApi() { return "third-party"; }
    thirdPartyApi.queue = ["keep"];
    thirdPartyApi.events = ["keep-event"];
    const allThirdParty = run({sddan: SDDAN_LOCAL, globals: {
        __tcfapi: thirdPartyApi, __sdcmpapi: thirdPartyApi, __uspapi: thirdPartyApi, __gpp: thirdPartyApi
    }, data: {partnerId: "1020", configId: "public"}});
    check("no pre-existing CMP API is replaced",
        allThirdParty.globals.__tcfapi === thirdPartyApi && allThirdParty.globals.__sdcmpapi === thirdPartyApi &&
        allThirdParty.globals.__uspapi === thirdPartyApi && allThirdParty.globals.__gpp === thirdPartyApi);
    check("no false handoff marker is published for third-party APIs",
        !allThirdParty.globals.ABconsentCMP.gtmTemplateMiniStubApis ||
        Object.keys(allThirdParty.globals.ABconsentCMP.gtmTemplateMiniStubApis).length === 0,
        JSON.stringify(allThirdParty.globals.ABconsentCMP.gtmTemplateMiniStubApis));

    const staleMarkerMap = {__tcfapi: true, __sdcmpapi: true, __uspapi: true, __gpp: true};
    const staleThirdParty = run({sddan: SDDAN_LOCAL, globals: {
        ABconsentCMP: {gtmTemplateMiniStubApis: staleMarkerMap},
        __tcfapi: thirdPartyApi, __sdcmpapi: thirdPartyApi, __uspapi: thirdPartyApi, __gpp: thirdPartyApi
    }, data: {partnerId: "1020", configId: "public"}});
    check("stale handoff markers never claim pre-existing third-party APIs",
        staleThirdParty.globals.__tcfapi === thirdPartyApi &&
        staleThirdParty.globals.__sdcmpapi === thirdPartyApi &&
        staleThirdParty.globals.__uspapi === thirdPartyApi && staleThirdParty.globals.__gpp === thirdPartyApi &&
        Object.keys(staleThirdParty.globals.ABconsentCMP.gtmTemplateMiniStubApis).length === 0,
        JSON.stringify(staleThirdParty.globals.ABconsentCMP.gtmTemplateMiniStubApis));
}

console.log("\n21. Activation overrides and loader ordering");
{
    const publishesVendorUpdateOwnership = (cmp) => Object.keys(cmp || {}).some((key) =>
        key.indexOf("Updates" + "OwnedByGtm") !== -1);
    const enabled = run({sddan: SDDAN_LOCAL, data: {
        facebookConsentMode: true, openAiConsentMode: true,
        partnerId: "1020", configId: "public"
    }});
    check("enabled publishes activation overrides",
        enabled.globals.ABconsentCMP.gtmFacebookConsentMode === true &&
        enabled.globals.ABconsentCMP.gtmOpenAiConsentMode === true);
    check("enabled publishes no vendor update ownership marker",
        !publishesVendorUpdateOwnership(enabled.globals.ABconsentCMP));
    check("Google updates are delegated to the CMP when Consent Mode is active",
        enabled.globals.ABconsentCMP.enableConsentMode === true);
    check("Google default handoff is true before the first default is emitted",
        enabled.calls.defaults.length > 0 && enabled.calls.defaultStates[0].googleDefaultSet === true,
        JSON.stringify(enabled.calls.defaultStates));
    const firstState = enabled.calls.injectionStates[0] || {};
    check("overrides and handoff are visible at the CMP injection",
        firstState.facebook === true && firstState.openai === true &&
        firstState.enableConsentMode === true && firstState.googleDefaultSet === true &&
        firstState.miniStubApis.__tcfapi === true &&
        firstState.miniStubApis.__sdcmpapi === true && firstState.miniStubApis.__uspapi === true &&
        firstState.miniStubApis.__gpp === true, JSON.stringify(firstState));
    const noGoogle = run({sddan: SDDAN_LOCAL, data: {
        consentMode: false, partnerId: "1020", configId: "public"
    }});
    check("Google Consent Mode switched off publishes no default handoff",
        noGoogle.calls.defaults.length === 0 &&
        noGoogle.globals.ABconsentCMP.gtmGoogleConsentModeDefaultSet === undefined &&
        (noGoogle.calls.injectionStates[0] || {}).googleDefaultSet === undefined,
        JSON.stringify(noGoogle.calls));
    // Switched off has to be ANNOUNCED, not left absent. An absent property resolves to whatever
    // the served script has stored, so a publisher who unticks the box would keep the default and
    // the updates of a configuration this page no longer drives -- the switch would do nothing.
    check("Google Consent Mode switched off is announced as false",
        noGoogle.globals.ABconsentCMP.enableConsentMode === false &&
        (noGoogle.calls.injectionStates[0] || {}).enableConsentMode === false,
        JSON.stringify(noGoogle.globals.ABconsentCMP));
    // The nominal path: nothing declared, so the automatic default state is what goes out. A
    // publisher who takes the defaults over but leaves the table empty lands here too -- emitting
    // no default at all would be worse than either mode.
    const automatic = run({sddan: SDDAN_LOCAL, data: {partnerId: "1020", configId: "public"}});
    const auto = automatic.calls.defaults[0] || {};
    check("the automatic default state is emitted once per perimeter",
        automatic.calls.defaults.length === 2, JSON.stringify(automatic.calls.defaults));
    check("the automatic default state refuses what the notice is about",
        auto.ad_storage === "denied" && auto.ad_user_data === "denied" &&
        auto.ad_personalization === "denied" && auto.analytics_storage === "denied" &&
        auto.personalization_storage === "denied", JSON.stringify(auto));
    // And grants the two that are not. One keeps the page working, the other keeps sign-in and
    // anti-fraud working; denying them buys no protection and breaks both until the answer arrives.
    check("and grants the two a notice is not about",
        auto.functionality_storage === "granted" && auto.security_storage === "granted",
        JSON.stringify(auto));
    // A default awaiting an answer, so there IS something to wait for -- and it names the regions
    // where a regulation applies, which is what leaves everywhere else to the global row.
    check("the regulated default waits for an update and names its perimeter",
        auto.wait_for_update === 1000 && auto.region && auto.region.length > 20,
        JSON.stringify(auto));
    const emptyOverride = run({sddan: SDDAN_LOCAL, data: Object.assign(withRows([]),
        {partnerId: "1020", configId: "public"})});
    check("an override with no rule falls back to the automatic default state",
        JSON.stringify(emptyOverride.calls.defaults) === JSON.stringify(automatic.calls.defaults),
        JSON.stringify(emptyOverride.calls.defaults));
    // Witness: the two runs above would agree just as well if rows were ignored outright. This is
    // what says the override still reaches the emission.
    const realOverride = run({sddan: SDDAN_LOCAL, data: Object.assign(
        withRows([{ad_storage: "granted", analytics_storage: "granted",
            personalization_storage: "granted", functionality_storage: "granted",
            security_storage: "granted", wait_for_update: 1000, region: "ALL"}]),
        {partnerId: "1020", configId: "public"})});
    check("witness -- declared rules do replace the automatic default state",
        realOverride.calls.defaults[0].ad_storage === "granted",
        JSON.stringify(realOverride.calls.defaults[0]));
    // And rows WITHOUT the override are rows the publisher never confirmed: a container saved
    // against an earlier version must not have them replayed.
    const staleRows = run({sddan: SDDAN_LOCAL, data: {
        customConsentSettings: [{ad_storage: "granted", analytics_storage: "granted",
            personalization_storage: "granted", functionality_storage: "granted",
            security_storage: "granted", wait_for_update: 1000, region: "ALL"}],
        partnerId: "1020", configId: "public"
    }});
    check("rules left over from an earlier configuration are ignored",
        JSON.stringify(staleRows.calls.defaults[0]) === JSON.stringify(auto),
        JSON.stringify(staleRows.calls.defaults[0]));
    // The snapshot handed to the served CMP is built by side effects inside the emission loop, so
    // it follows the same resolved list. A loop that never ran would leave every signal at
    // "not used" and hand over something the CMP cannot act on -- without failing anything else.
    const handoff = JSON.parse(automatic.globals.ABconsentCMP.gtmTemplateDefaultConsent || "{}");
    check("the automatic state is handed to the CMP as a real snapshot",
        handoff.ad_storage === "denied" && handoff.analytics_storage === "denied" &&
        handoff.personalization_storage === "denied" &&
        handoff.functionality_storage === "granted" && handoff.security_storage === "granted",
        JSON.stringify(handoff));
    // One request, and it is the bundle. The page is prepared by this tag -- queues and defaults
    // -- so a request in front of the bundle would spend a round trip re-doing that work.
    check("the loader asks for the bundle and nothing in front of it",
        enabled.calls.injected.length === 1 && enabled.calls.injected[0].indexOf("/cmp") !== -1,
        JSON.stringify(enabled.calls.injected));
    check("the request names the tag manager that prepared the page",
        enabled.calls.injected[0].indexOf("tms=gtm") !== -1, JSON.stringify(enabled.calls.injected));
    check("regular loader completes GTM exactly once", enabled.calls.successes === 1 && enabled.calls.failures === 0,
        JSON.stringify([enabled.calls.successes, enabled.calls.failures]));
    check("Consent Mode update API is not required or called",
        SRC.indexOf("require('updateConsentState')") === -1 && enabled.calls.updates.length === 0);
    check("no consent listener is registered when cookie deletion is disabled", enabled.listener === null);

    // There is no third state, so a setting left alone is not silence: it publishes an explicit
    // false. `globals` is deliberately NOT seeded and Google Consent Mode is off, so nothing else
    // in this run would write `ABconsentCMP` -- the object can only exist here because the
    // template now writes it unconditionally.
    const unset = run({sddan: SDDAN_LOCAL, data: {consentMode: false}});
    check("settings left unset publish explicit false to the page, never absent",
        !!unset.globals.ABconsentCMP &&
        unset.globals.ABconsentCMP.gtmFacebookConsentMode === false &&
        unset.globals.ABconsentCMP.gtmOpenAiConsentMode === false,
        JSON.stringify(unset.globals.ABconsentCMP));
    check("settings left unset publish no vendor update ownership marker",
        !publishesVendorUpdateOwnership(unset.globals.ABconsentCMP));
    check("settings left unset install no vendor queue", unset.globals.fbq === undefined && unset.globals.oaiq === undefined);

    const disabled = run({sddan: SDDAN_LOCAL, data: {
        consentMode: false, facebookConsentMode: false, openAiConsentMode: false
    }});
    check("disabled publishes false activation overrides",
        disabled.globals.ABconsentCMP.gtmFacebookConsentMode === false &&
        disabled.globals.ABconsentCMP.gtmOpenAiConsentMode === false);
    check("disabled publishes no vendor update ownership marker",
        !publishesVendorUpdateOwnership(disabled.globals.ABconsentCMP));
    check("disabled installs no vendor queue", disabled.globals.fbq === undefined && disabled.globals.oaiq === undefined);

    const deletion = run({sddan: SDDAN_LOCAL, data: {
        handleCookiesDeletion: true, partnerId: "1020", configId: "public"
    }});
    check("Sirdata listener remains only for cookie deletion", typeof deletion.listener === "function");
    // BEFORE the request, not after it. The queue the command waits in is installed by this tag,
    // so there is nothing left to wait for; registering it on a load event was only ever a
    // consequence of that queue arriving with the script.
    check("the cookie listener is registered before the bundle is asked for",
        deletion.calls.listenerAfterInjections === 0,
        JSON.stringify([deletion.calls.listenerAfterInjections, deletion.calls.injected]));
    const beforeUpdates = deletion.calls.updates.length;
    deletion.listener(purgeEvent("_ga"), true);
    check("cookie callback emits no Google update", deletion.calls.updates.length === beforeUpdates);

    // The first-party loader is not ours, so the command cannot be issued before it: it goes into
    // the callback list that loader drains once the script it serves is in place.
    const deletionFirstParty = run({sddan: SDDAN_LOCAL, data: {
        handleCookiesDeletion: true, firstPartyHost: "cmp.example.com", partnerId: "1020", configId: "public"
    }});
    check("on the first-party path the listener still arrives, through the callback list",
        typeof deletionFirstParty.listener === "function" &&
        deletionFirstParty.calls.listenerAfterInjections === 1,
        JSON.stringify([deletionFirstParty.calls.listenerAfterInjections, deletionFirstParty.calls.injected]));

    const firstParty = run({sddan: SDDAN_LOCAL, data: {
        firstPartyHost: "cmp.example.com", partnerId: "1020", configId: "public"
    }});
    check("first-party loader remains the sole network loader on its success path",
        firstParty.calls.injected.length === 1 && firstParty.calls.injected[0].indexOf("cmp_loader.js") !== -1,
        JSON.stringify(firstParty.calls.injected));
    check("first-party loader completes exactly once", firstParty.calls.successes === 1 && firstParty.calls.failures === 0,
        JSON.stringify([firstParty.calls.successes, firstParty.calls.failures]));
    check("the first-party request names the tag manager too",
        firstParty.calls.injected[0].indexOf("tms=gtm") !== -1, JSON.stringify(firstParty.calls.injected));

    const fallback = run({sddan: SDDAN_LOCAL, failInjection: "cmp_loader.js", data: {
        firstPartyHost: "cmp.example.com", partnerId: "1020", configId: "public"
    }});
    check("first-party failure falls back to the direct bundle request",
        fallback.calls.injected.length === 2 && fallback.calls.injected[0].indexOf("cmp_loader.js") !== -1 &&
        fallback.calls.injected[1].indexOf("/cmp") !== -1,
        JSON.stringify(fallback.calls.injected));
    check("fallback completes exactly once", fallback.calls.successes === 1 && fallback.calls.failures === 0,
        JSON.stringify([fallback.calls.successes, fallback.calls.failures]));

    const cmpFailure = run({sddan: SDDAN_LOCAL, failInjection: "/cmp", data: {
        partnerId: "1020", configId: "public"
    }});
    check("CMP bundle failure reports GTM failure exactly once",
        cmpFailure.calls.successes === 0 && cmpFailure.calls.failures === 1,
        JSON.stringify([cmpFailure.calls.successes, cmpFailure.calls.failures]));
}

console.log("\n22. Early vendor defaults preserve files and callbacks produce no updates");
{
    // A queue whose methods THROW on any call. This is the case the shared-storage question used
    // to reach, and the reason it had to stop reaching it: the sandbox cannot contain an exception,
    // so a single throw stopped the template mid-way and left whatever it had written behind for
    // the SDK to drain. The mark is a named property now, so these methods are never called and
    // the case passes because the code cannot get there -- not because it recovers.
    function throwingMethods(queue) {
        queue.push = function () { throw new Error("publisher push"); };
        queue.splice = function () { throw new Error("publisher splice"); };
        return queue;
    }
    function hostileOaiq() {}
    hostileOaiq.q = throwingMethods([["measure", "survives-throwing-methods"]]);
    hostileOaiq.queue = throwingMethods([["init", {pixelId: "hostile"}]]);
    const hostileOpenAi = run({sddan: SDDAN_LOCAL, globals: {oaiq: hostileOaiq},
        data: {openAiConsentMode: true}});
    const hostileOpenAiCommands = commandList(hostileOpenAi.globals.oaiq.queue);
    check("OpenAI survives a queue whose methods throw",
        Array.isArray(hostileOpenAi.globals.oaiq.queue), JSON.stringify(hostileOpenAiCommands));
    // The commands are still PRESERVED -- they are preserved somewhere else, which is the whole
    // point of holding them: under a refusing default the pixel would drain them and DROP them, so
    // they are parked on the resumption point instead of being handed over to be thrown away.
    // Both names are read, and both their commands are held: `init` joined the held list when it
    // turned out to send a diagnostic event of its own before the visitor has answered.
    const hostileHeld = commandList(hostileOpenAi.globals.ABconsentCMP.openai.preQueue);
    check("OpenAI preserves business commands from both names when methods throw",
        hostileHeld.some((command) =>
            command[0] === "measure" && command[1] === "survives-throwing-methods") &&
        hostileHeld.some((command) => command[0] === "init"),
        JSON.stringify([hostileOpenAiCommands, hostileHeld]));
    check("and nothing held is left in the drained queue as well",
        !hostileOpenAiCommands.some((command) =>
            command[0] === "measure" || command[0] === "init"),
        JSON.stringify(hostileOpenAiCommands));
    check("OpenAI publishes no mark and no sentinel when methods throw",
        hostileOpenAiCommands.every((command) => typeof command[0] === "string") &&
        JSON.stringify(hostileOpenAiCommands).indexOf("__sd") === -1,
        JSON.stringify(hostileOpenAiCommands));
    // The run completing at all is what says the throw was never triggered: an exception here
    // would have stopped the template before the loader.
    check("the template still completes when a queue method throws",
        hostileOpenAi.calls.successes + hostileOpenAi.calls.failures >= 0 &&
        hostileOpenAi.globals.ABconsentCMP !== undefined);

    function hostileFbq() { throw new Error("publisher fbq"); }
    hostileFbq.queue = throwingMethods([["track", "SurvivesThrowingMethods"]]);
    hostileFbq.push = hostileFbq;
    const hostileMeta = run({sddan: SDDAN_LOCAL, globals: {fbq: hostileFbq, _fbq: hostileFbq},
        data: {facebookConsentMode: true}});
    const hostileMetaCommands = commandList(hostileMeta.globals.fbq.queue);
    check("Meta survives a queue whose methods throw",
        Array.isArray(hostileMeta.globals.fbq.queue), JSON.stringify(hostileMetaCommands));
    check("Meta preserves business commands when methods throw",
        hostileMetaCommands.some((command) =>
            command[0] === "track" && command[1] === "SurvivesThrowingMethods"),
        JSON.stringify(hostileMetaCommands));
    check("Meta publishes no mark and no sentinel when methods throw",
        JSON.stringify(hostileMetaCommands).indexOf("__sd") === -1, JSON.stringify(hostileMetaCommands));

    // The mark never becomes an entry, so it cannot be drained as a command whatever happens
    // afterwards -- and it is cleared once the question is answered rather than left on the object.
    function markedOaiq() {}
    const sharedList = [["measure", "shared"]];
    markedOaiq.q = sharedList;
    markedOaiq.queue = sharedList;
    const marked = run({sddan: SDDAN_LOCAL, globals: {oaiq: markedOaiq}, data: {openAiConsentMode: true}});
    // Assert on the ORIGINAL array, not on what the template publishes afterwards. The published
    // list is a fresh array that never carried the mark, so reading it there is a check that
    // cannot fail -- measured: removing the line that clears the mark left it green.
    check("the mark is cleared from the publisher's own list",
        sharedList.__sdSharedStorage === undefined, JSON.stringify(sharedList.__sdSharedStorage));
    const markedCommands = commandList(marked.globals.oaiq.queue);
    const markedHeld = commandList(marked.globals.ABconsentCMP.openai.preQueue);
    check("one shared list is read once, not twice",
        named(markedHeld, "measure").length === 1 && named(markedCommands, "measure").length === 0,
        JSON.stringify([markedCommands, markedHeld]));

    // The closed finding stays closed: two DISTINCT lists holding identical commands are two
    // lists. A publisher who installed the pixel both ways with the same identifier has exactly
    // that, so collapsing them would drop one real set of pending work.
    function twinOaiq() {}
    const twinQ = [["init", {pixelId: "same"}]];
    const twinQueue = [["init", {pixelId: "same"}]];
    twinOaiq.q = twinQ;
    twinOaiq.queue = twinQueue;
    const twins = run({sddan: SDDAN_LOCAL, globals: {oaiq: twinOaiq}, data: {openAiConsentMode: true}});
    const twinCommands = commandList(twins.globals.oaiq.queue);
    const twinHeld = commandList(twins.globals.ABconsentCMP.openai.preQueue);
    check("distinct lists with identical commands are kept apart",
        named(twinHeld, "init").length === 2, JSON.stringify([twinCommands, twinHeld]));
    check("the mark is cleared on distinct lists too",
        twinQueue.__sdSharedStorage === undefined && twinQ.__sdSharedStorage === undefined,
        JSON.stringify([twinQueue.__sdSharedStorage, twinQ.__sdSharedStorage]));

    // Meta reads its canonical list alone, so another advertiser's pixel is no longer merged in.
    function ownFbq() { ownFbq.queue.push(Array.prototype.slice.call(arguments)); }
    ownFbq.queue = [["track", "Ours"]];
    ownFbq.push = ownFbq;
    function strangerFbq() {}
    strangerFbq.queue = [["track", "TheirsDoNotTake"]];
    const stranger = run({sddan: SDDAN_LOCAL, globals: {fbq: ownFbq, _fbq: strangerFbq},
        data: {facebookConsentMode: true}});
    const strangerCommands = commandList(stranger.globals.fbq.queue);
    check("witness -- our own pending command is kept",
        strangerCommands.some((command) => command[1] === "Ours"), JSON.stringify(strangerCommands));
    check("another advertiser's pending commands are never merged in",
        !strangerCommands.some((command) => command[1] === "TheirsDoNotTake"),
        JSON.stringify(strangerCommands));

    function beforeOaiq() { beforeOaiq.queue.push(Array.prototype.slice.call(arguments)); }
    beforeOaiq.q = [["consent", false], ["init", {pixelId: "pixel"}], ["pixelId", "pixel"]];
    beforeOaiq.queue = [["consent", "publisher"], ["measure", "page_viewed"], ["set", "user", {id: "user"}]];
    const openai = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.o:1:1"}, globals: {oaiq: beforeOaiq}, data: {
        openAiConsentMode: true, handleCookiesDeletion: true,
        partnerId: "1020", configId: "public"
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
            data: {openAiConsentMode: true}});
        check("OpenAI conservative default " + fixture[0],
            commandList(result.globals.oaiq.queue)[0][1] === fixture[1]);
    });

    function beforeFbq() { beforeFbq.queue.push(Array.prototype.slice.call(arguments)); }
    beforeFbq.queue = [["consent", "publisher"], ["dataProcessingOptions", ["LDU"], 0, 0],
        ["init", "pixel", {em: "hash"}], ["track", "PageView"]];
    beforeFbq.push = beforeFbq;
    const meta = run({sddan: SDDAN_LOCAL, globals: {fbq: beforeFbq, _fbq: beforeFbq}, data: {
        facebookConsentMode: true, handleCookiesDeletion: true,
        partnerId: "1020", configId: "public"
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
            openAiConsentMode: true, handleCookiesDeletion: true,
            partnerId: "1020", configId: "public"
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
        data: {openAiConsentMode: true}});
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
        facebookConsentMode: true, handleCookiesDeletion: true,
        partnerId: "1020", configId: "public"
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

console.log("\n23. The privacy marker and the stored bits reach the Meta and OpenAI defaults");
{
    const readsOf = (r, name) => (r.calls.cookieReads[name] || 0);
    const GRANTING_CONTAINER = "2.o:1:1";
    const OPENAI_ON = {openAiConsentMode: true};
    const consentOf = (r) => {
        const consent = named(commandList(r.globals.oaiq.queue), "consent");
        return consent.length === 1 ? consent[0][1] : JSON.stringify(consent);
    };

    // Witness: WITHOUT the marker the stored bit decides, and the container IS read. Without it
    // the two assertions below would also be satisfied by a template that stopped reading the
    // container at all, or by a harness whose container string says nothing -- a check that
    // cannot fail checks nothing.
    const temoin = run({sddan: SDDAN_LOCAL, data: OPENAI_ON,
        cookies: {"__sdgcm": GRANTING_CONTAINER}});
    check("witness -- without the marker the stored OpenAI bit is honored",
        consentOf(temoin) === true, JSON.stringify(consentOf(temoin)));
    check("witness -- and the container IS read", readsOf(temoin, "__sdgcm") >= 1,
        String(readsOf(temoin, "__sdgcm")));

    // The marker covers EVERY vendor, not only the ones the container happens to carry a bit
    // for. The served CMP applies that same precedence to this vendor, so a template that read
    // the bit here would disagree with it for a whole page view.
    const court = run({sddan: SDDAN_LOCAL, data: OPENAI_ON,
        cookies: {"__gpcactive": "1", "__sdgcm": GRANTING_CONTAINER}});
    check("the marker denies the OpenAI default even when the container grants",
        consentOf(court) === false, JSON.stringify(consentOf(court)));
    // Pinned on the READ, exactly as section 14 does for Google: an implementation that reads the
    // container and then overwrites what it found emits the same value while consulting a cookie
    // whose answer cannot change the outcome. Only the count separates the two.
    check("and the container is NOT consulted", readsOf(court, "__sdgcm") === 0,
        String(readsOf(court, "__sdgcm")));

    // Meta follows the SAME rule, with one asymmetry that decides its shape. The stored Meta bit
    // does not mean the same thing under both regimes -- a consent under GDPR, the ABSENCE of an
    // objection under the US one -- and only the GDPR reading calls for a `revoke`, which PAUSES
    // the pixel outright. A US objection is expressed by limiting data use, which keeps it
    // sending. So the bit may RAISE this default to a grant and never lower it below the
    // conservative one: a returning US visitor who objected is limited by the CMP, not paused
    // here. Reading it symmetrically would cost that visitor their whole measurement.
    const META_ON = {facebookConsentMode: true};
    const META_GRANTING_CONTAINER = "2.m:1:1";
    const metaConsentOf = (r) => {
        const consent = named(commandList(r.globals.fbq.queue), "consent");
        return consent.length === 1 ? [consent[0][1], consent[0][2]] : consent;
    };
    const MARKED = (verb) => JSON.stringify([verb, "__abconsent_temporary__"]);

    const metaSansEtat = run({sddan: SDDAN_LOCAL, data: META_ON});
    check("without stored state the Meta default stays a marked revoke",
        JSON.stringify(metaConsentOf(metaSansEtat)) === MARKED("revoke"),
        JSON.stringify(metaConsentOf(metaSansEtat)));

    const metaAccorde = run({sddan: SDDAN_LOCAL, data: META_ON,
        cookies: {"__sdgcm": META_GRANTING_CONTAINER}});
    check("a granting stored Meta bit raises the default to a marked grant",
        JSON.stringify(metaConsentOf(metaAccorde)) === MARKED("grant"),
        JSON.stringify(metaConsentOf(metaAccorde)));
    check("and the container IS read for Meta", readsOf(metaAccorde, "__sdgcm") >= 1,
        String(readsOf(metaAccorde, "__sdgcm")));

    // Same precedence as OpenAI above, and pinned on the READ for the same reason.
    const metaCourt = run({sddan: SDDAN_LOCAL, data: META_ON,
        cookies: {"__gpcactive": "1", "__sdgcm": META_GRANTING_CONTAINER}});
    check("the privacy marker denies the Meta default even when the container grants",
        JSON.stringify(metaConsentOf(metaCourt)) === MARKED("revoke"),
        JSON.stringify(metaConsentOf(metaCourt)));
    check("and the container is NOT consulted for Meta", readsOf(metaCourt, "__sdgcm") === 0,
        String(readsOf(metaCourt, "__sdgcm")));

    // THE FUNCTION INSTALLED FOR A PAGE WITHOUT A PIXEL MUST ROUTE TO THE SDK.
    //
    // Meta's SDK attaches `callMethod` to the function already on the page instead of replacing
    // it, so a function that only appends never reaches the SDK -- and a consent signal sent after
    // the SDK has loaded lands BEHIND the events it was meant to release. The SDK stops draining at
    // the provisional denial ahead of them, so the pixel stays paused for the whole page view with
    // nothing to indicate it. No assertion on the prepared list can see that: the list is correct
    // either way, and only where a LATER call goes tells the two apart.
    const neuf = run({sddan: SDDAN_LOCAL, data: META_ON});
    check("witness -- a page without a pixel gets a function and a list",
        typeof neuf.globals.fbq === "function" && Array.isArray(neuf.globals.fbq.queue),
        typeof neuf.globals.fbq);
    const avantSdk = commandList(neuf.globals.fbq.queue).length;
    neuf.globals.fbq("track", "BeforeTheSdk");
    check("before the SDK the call is held in the list",
        commandList(neuf.globals.fbq.queue).length === avantSdk + 1,
        JSON.stringify(commandList(neuf.globals.fbq.queue)));

    // The SDK arrives the way it really does: it attaches `callMethod` to the existing function.
    const recus = [];
    neuf.globals.fbq.callMethod = function () { recus.push(Array.prototype.slice.call(arguments)); };
    const apresSdk = commandList(neuf.globals.fbq.queue).length;
    neuf.globals.fbq("consent", "grant");
    check("once the SDK is there the call REACHES it",
        recus.length === 1 && recus[0][0] === "consent" && recus[0][1] === "grant",
        JSON.stringify(recus));
    check("a short call arrives SHORT, not padded with undefined",
        recus[0] && recus[0].length === 2, JSON.stringify(recus));
    check("and it is NOT appended to the list instead",
        commandList(neuf.globals.fbq.queue).length === apresSdk,
        JSON.stringify(commandList(neuf.globals.fbq.queue)));
    neuf.globals.fbq("dataProcessingOptions", ["LDU"], 0, 0);
    check("the routed call keeps its exact arity",
        recus.length === 2 && recus[1].length === 4 && recus[1][3] === 0,
        JSON.stringify(recus));

    // A function already on the page is never replaced: it carries the flags their snippet set and
    // their own routing, and their snippet exits on `if (f.fbq)` so nothing would put them back.
    function pixelEditeur() { pixelEditeur.queue.push(Array.prototype.slice.call(arguments)); }
    pixelEditeur.queue = [["track", "PageView"]];
    pixelEditeur.push = pixelEditeur;
    pixelEditeur.loaded = true;
    pixelEditeur.version = "2.0";
    function aliasEtranger() {}
    const garde = run({sddan: SDDAN_LOCAL, globals: {fbq: pixelEditeur, _fbq: aliasEtranger},
        data: META_ON});
    check("an existing pixel function is kept, with its own flags",
        garde.globals.fbq === pixelEditeur && garde.globals.fbq.loaded === true &&
        garde.globals.fbq.version === "2.0", typeof garde.globals.fbq);
    check("and another advertiser's alias is not overwritten",
        garde.globals._fbq === aliasEtranger);
    check("witness -- the provisional default still comes first on that page",
        JSON.stringify(metaConsentOf(garde)) === MARKED("revoke"),
        JSON.stringify(commandList(garde.globals.fbq.queue)));
}

console.log("\n24. A measurement is held out of the queue the pixel drains while the default refuses");
{
    const OPENAI_ON = {openAiConsentMode: true};
    // The pixel DROPS a measurement received while consent is denied -- it does not hold it and it
    // never replays it. Handing one over before the visitor has answered therefore loses it for
    // good, so it is parked on the resumption point the consent script reads instead.
    const refus = run({sddan: SDDAN_LOCAL, data: OPENAI_ON});
    check("witness -- a page without a pixel gets a function and a list",
        typeof refus.globals.oaiq === "function" && Array.isArray(refus.globals.oaiq.queue),
        typeof refus.globals.oaiq);
    const avant = commandList(refus.globals.oaiq.queue).length;
    refus.globals.oaiq("measure", "page_viewed", {type: "contents"});
    const tenus = commandList(refus.globals.ABconsentCMP.openai.preQueue);
    check("a measurement is held on the resumption point",
        named(tenus, "measure").length === 1 && tenus[0][1] === "page_viewed",
        JSON.stringify(tenus));
    check("and it is NOT appended to the queue the pixel drains",
        commandList(refus.globals.oaiq.queue).length === avant,
        JSON.stringify(commandList(refus.globals.oaiq.queue)));
    refus.globals.oaiq("measureSingle", "pix", "page_viewed", {type: "contents"});
    check("the single-pixel form is held too, with its exact arity",
        named(commandList(refus.globals.ABconsentCMP.openai.preQueue), "measureSingle").length === 1 &&
        commandList(refus.globals.ABconsentCMP.openai.preQueue)[1].length === 4,
        JSON.stringify(commandList(refus.globals.ABconsentCMP.openai.preQueue)));
    // `init` is held too, and this assertion USED to pin the opposite: it read "a command that is
    // not a measurement still goes to the queue" and named `init` as the example. The premise
    // changed rather than the code drifting -- initialising the pixel sends a diagnostic event
    // carrying `consent: false`, so it is not free to hand over before the visitor has answered.
    refus.globals.oaiq("init", {pixelId: "pix"});
    check("initialising the pixel is held too, out of the queue it drains",
        named(commandList(refus.globals.ABconsentCMP.openai.preQueue), "init").length === 1 &&
        named(commandList(refus.globals.oaiq.queue), "init").length === 0,
        JSON.stringify([commandList(refus.globals.oaiq.queue),
            commandList(refus.globals.ABconsentCMP.openai.preQueue)]));
    // The witness that the held set is a LIST and not "everything that is not consent": a command
    // nobody has read still goes to the queue, where it is visible, rather than being held with no
    // trace of why it never ran.
    refus.globals.oaiq("someLaterCommand", "x");
    check("a command that is on neither list still goes to the queue",
        named(commandList(refus.globals.oaiq.queue), "someLaterCommand").length === 1 &&
        named(commandList(refus.globals.ABconsentCMP.openai.preQueue), "someLaterCommand").length === 0,
        JSON.stringify([commandList(refus.globals.oaiq.queue),
            commandList(refus.globals.ABconsentCMP.openai.preQueue)]));

    // THE OTHER DIRECTION, and it is what keeps the change from delaying what already works: under
    // a stored grant the pixel accepts measurements, so nothing is held back.
    const accord = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.o:1:1"}, data: OPENAI_ON});
    accord.globals.oaiq("measure", "page_viewed", {type: "contents"});
    check("under a stored grant the measurement goes straight to the queue",
        named(commandList(accord.globals.oaiq.queue), "measure").length === 1,
        JSON.stringify(commandList(accord.globals.oaiq.queue)));
    check("and no list is created to hold it",
        !accord.globals.ABconsentCMP.openai ||
        commandList(accord.globals.ABconsentCMP.openai.preQueue || []).length === 0,
        JSON.stringify(accord.globals.ABconsentCMP.openai));

    // A list the consent script already published is KEPT, never replaced: a page that loaded it
    // first would otherwise lose what it holds.
    const deja = [["measure", "already-there", {type: "contents"}]];
    const repris = run({sddan: SDDAN_LOCAL, data: OPENAI_ON,
        globals: {ABconsentCMP: {openai: {preQueue: deja}}}});
    repris.globals.oaiq("measure", "page_viewed", {type: "contents"});
    check("an existing resumption list is kept and appended to",
        named(commandList(repris.globals.ABconsentCMP.openai.preQueue), "measure").length === 2,
        JSON.stringify(commandList(repris.globals.ABconsentCMP.openai.preQueue)));
}

console.log("\n25. A regional refusal, then a global one that carries the ad signals");
{
    // The documented shape: one region-scoped default for the perimeter where a notice is shown,
    // and one region-less default that is the status for everyone else.
    const r = run({sddan: SDDAN_LOCAL});
    const defauts = r.calls.defaults;
    check("witness -- two defaults", defauts.length === 2,
        JSON.stringify(defauts.map((d) => d.region)));

    const regional = defauts[0];
    const global = defauts[1];
    check("the first names the perimeter, the second names no region",
        regional.region && regional.region.length > 0 && global.region === undefined,
        JSON.stringify(defauts.map((d) => d.region)));

    // The regional row refuses what the notice is about, and waits, because an answer is coming
    // there. It does NOT refuse the other two: one keeps the page working, the other keeps sign-in
    // and anti-fraud working, and neither is what a notice asks about.
    check("the regional row denies what the notice is about and waits",
        regional.ad_storage === "denied" && regional.analytics_storage === "denied" &&
        regional.personalization_storage === "denied" && regional.wait_for_update === 1000,
        JSON.stringify(regional));
    check("and grants the two it is not about",
        regional.functionality_storage === "granted" && regional.security_storage === "granted",
        JSON.stringify(regional));

    // THE assertion of this section: the global row GRANTS. That is what the documented region
    // table says the unnamed case already is -- stating it makes it explicit rather than leaning
    // on the ambient default. All three advertising signals, because the generator denies the two
    // v2 ones on any row that does not name them.
    check("the global row GRANTS advertising",
        global.ad_storage === "granted" && global.ad_user_data === "granted" &&
        global.ad_personalization === "granted", JSON.stringify(global));
    // And it names EVERY signal, not just the advertising ones. Leaving the other four unset was
    // defensible -- an unset signal behaves as granted -- and it read as an omission beside a
    // regional command that states all of them. Two commands describing the same seven signals in
    // two vocabularies is a thing a reader has to check twice.
    check("the global row names every signal",
        global.analytics_storage === "granted" && global.personalization_storage === "granted" &&
        global.functionality_storage === "granted" && global.security_storage === "granted",
        JSON.stringify(global));
    check("and does not make gtag wait, there being no answer coming",
        !global.wait_for_update, JSON.stringify(global));

    // The perimeter is the CMP's own list plus the US, not one invented here.
    const regule = regional.region || [];
    check("the perimeter carries the EEA, the UK, Switzerland, Brazil and the US",
        ["FR", "DE", "IT", "GB", "CH", "BR", "US"].every((c) => regule.indexOf(c) >= 0),
        JSON.stringify(regule));
    check("and the overseas territories a country code would not match",
        ["MQ", "GP", "RE", "YT", "GF"].every((c) => regule.indexOf(c) >= 0), JSON.stringify(regule));
    // Everywhere else is covered by the global row rather than by being named.
    check("it does NOT name a country where no regulation applies",
        regule.indexOf("IL") === -1 && regule.indexOf("JP") === -1, JSON.stringify(regule));

    // The chain still runs per row, and on a denied global row it can only relax -- which is the
    // property that makes this shape safe where the granted one was not.
    // The chain still runs per row. A visitor who carries nothing -- which is every first-time
    // visitor outside the perimeter -- keeps the granted global row, and that is the case the
    // reported defect was about.
    const gpc = run({sddan: SDDAN_LOCAL, cookies: {"__gpcactive": "1", "__sdgcm": "2.g:1:1111111"}});
    check("a privacy marker denies both rows, global one included",
        gpc.calls.defaults.length === 2 &&
        gpc.calls.defaults.every((d) => d.ad_storage === "denied"),
        JSON.stringify(gpc.calls.defaults));

    const stocke = run({sddan: SDDAN_LOCAL,
        cookies: {"__sdgcm": "1.1111111", "euconsent-v2": "CP..."}});
    check("a recorded choice is replayed onto both",
        stocke.calls.defaults.length === 2 &&
        stocke.calls.defaults.every((d) => d.ad_storage === "granted"),
        JSON.stringify(stocke.calls.defaults));

    // NOTHING changes for a publisher who declares their own table.
    const manuel = run({sddan: SDDAN_LOCAL, data: withRows([{ad_storage: "granted",
        analytics_storage: "granted", personalization_storage: "granted",
        functionality_storage: "granted", security_storage: "granted",
        wait_for_update: 1000, region: "ALL"}])});
    check("a declared table emits its own rows and nothing else",
        manuel.calls.defaults.length === 1 && manuel.calls.defaults[0].region === undefined,
        JSON.stringify(manuel.calls.defaults));
    check("and the two ad signals it cannot name stay denied there",
        manuel.calls.defaults[0].ad_user_data === "denied" &&
        manuel.calls.defaults[0].ad_personalization === "denied",
        JSON.stringify(manuel.calls.defaults[0]));
}

// Every declared function is called with the number of arguments it declares.
//
// WHY: a caller was removed and its callee kept its signature. `generateConsentObject` went on
// declaring four parameters while the one remaining call passed three, so a whole branch of every
// ternary in it -- and the comment explaining that branch -- described behaviour no call could
// reach. Nothing here saw it, because a parameter left `undefined` is not an error in JS: it just
// makes a test that never fails.
//
// This reads the sandboxed body rather than replaying it, so it covers functions no scenario
// exercises. Its own scanner is pinned first: a scanner that finds nothing reads exactly like a
// clean template.
{
    const code = stripComments(SRC);

    // Walks from the "(" at `start` to its matching ")", following quotes, and returns what is
    // between them. Returns null on an unterminated call rather than a truncated one -- a partial
    // argument list would be counted, and counted wrong.
    function insideParens(text, start) {
        let depth = 0;
        let quote = null;
        for (let j = start; j < text.length; j += 1) {
            const c = text[j];
            if (quote) {
                if (c === "\\") { j += 1; continue; }
                if (c === quote) { quote = null; }
                continue;
            }
            if (c === "\"" || c === "'" || c === "`") { quote = c; continue; }
            if (c === "(") { depth += 1; }
            else if (c === ")") {
                depth -= 1;
                if (depth === 0) { return {body: text.slice(start + 1, j), end: j}; }
            }
        }
        return null;
    }

    // Splits on top-level commas only: `fn(a, g(b, c))` is TWO arguments, not three.
    function topLevelParts(body) {
        const parts = [];
        let cur = "";
        let depth = 0;
        let quote = null;
        for (let i = 0; i < body.length; i += 1) {
            const c = body[i];
            if (quote) {
                cur += c;
                if (c === "\\") { cur += body[i + 1] || ""; i += 1; continue; }
                if (c === quote) { quote = null; }
                continue;
            }
            if (c === "\"" || c === "'" || c === "`") { quote = c; cur += c; continue; }
            if (c === "(" || c === "[" || c === "{") { depth += 1; }
            if (c === ")" || c === "]" || c === "}") { depth -= 1; }
            if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
            cur += c;
        }
        if (cur.trim()) { parts.push(cur); }
        return parts.filter((s) => s.trim().length > 0);
    }

    // The three declaration forms this template actually uses. The `function` expression form is
    // the one the defect hid behind: a scanner that only knew arrows and named declarations read
    // the file clean.
    function declarations(text) {
        const found = {};
        const forms = [
            [/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(/g, true],
            [/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*function\s*\(/g, false],
            [/function\s+([A-Za-z_$][\w$]*)\s*\(/g, false]
        ];
        forms.forEach((form) => {
            const re = form[0];
            const mustBeArrow = form[1];
            let m;
            while ((m = re.exec(text)) !== null) {
                const open = m.index + m[0].length - 1;
                const span = insideParens(text, open);
                if (!span) { continue; }
                // `const x = (a + b) * c` is not a function; only an arrow follows the ")".
                if (mustBeArrow && text.slice(span.end + 1, span.end + 12).replace(/\s/g, "").indexOf("=>") !== 0) {
                    continue;
                }
                found[m[1]] = {at: open, params: topLevelParts(span.body).length};
            }
        });
        return found;
    }

    function mismatches(text) {
        const decls = declarations(text);
        const bad = [];
        Object.keys(decls).forEach((name) => {
            const re = new RegExp("(^|[^\\w$.])" + name + "\\s*\\(", "g");
            let m;
            while ((m = re.exec(text)) !== null) {
                const open = m.index + m[0].length - 1;
                if (open === decls[name].at) { continue; }
                const span = insideParens(text, open);
                if (!span) { continue; }
                const given = topLevelParts(span.body).length;
                if (given !== decls[name].params) {
                    bad.push(name + " declares " + decls[name].params + ", called with " + given);
                }
            }
        });
        return bad;
    }

    // Pinned on synthetic sources, both ways, because the whole value of this guard is that it
    // reddens: one that silently finds nothing is indistinguishable from a clean template.
    [
        ["an arrow called short", "const f = (a, b) => a; f(1);", 1],
        ["a function expression called short -- the form that hid the defect",
            "const g = function(a, b, c, d) { return a; }; g(1, 2, 3);", 1],
        ["a named declaration called long", "function h(a) { return a; } h(1, 2);", 1],
        ["a nested call is ONE argument", "const k = function(a, b) { return a; }; k(1, m(2, 3));", 0],
        ["a comma inside a string is not a separator", "const s = (a, b) => a; s('x,y', 2);", 0],
        ["a value passed, never called, is not a call site", "const v = (a, b) => a; reg('e', v);", 0],
        ["matching arities are silent", "const ok = function(a, b) { return a; }; ok(1, 2);", 0]
    ].forEach((c) => {
        check("arity scanner: " + c[0], mismatches(c[1]).length === c[2],
            JSON.stringify(mismatches(c[1])));
    });

    // Witness: the scanner must be seeing real functions here, otherwise "no mismatch" means
    // "nothing was read".
    const declared = Object.keys(declarations(code));
    check("the scanner reads the template's functions", declared.length > 20, String(declared.length));
    check("including the one the defect was in", declared.indexOf("generateConsentObject") !== -1,
        declared.join(","));

    const bad = mismatches(code);
    check("no function is called with the wrong number of arguments", bad.length === 0, bad.join(" | "));
}

// The handoff object is published only from synchronous flow.
//
// WHY: `ABconsentCMP` is read ONCE, at the top, and `copyFromWindow` hands back a copy. Every
// publication then writes that copy back with overrideExisting, which REPLACES the window object
// wholesale. That is safe for exactly one reason -- nothing else on the page can run between the
// read and the last write, because all of it is one synchronous run. It stops being safe the
// moment a publication happens from something deferred: an installed function, a load callback, a
// listener. Such a write would put back a snapshot taken before the CMP script existed, erasing
// whatever it had written in between, and neither the assertions below nor the tag itself would
// notice.
//
// The tag already has deferred code -- the function installed on `oaiq` -- and it deliberately
// does NOT republish: it reaches its target through the exact window path instead. That is the
// shape to keep, and this is what keeps it.
{
    const code = stripComments(SRC);

    // A deferred body here is a function LITERAL passed as an argument: what `setInWindow`
    // installs, what `injectScript` calls back, what a listener registration hands over. A
    // function assigned to a name is not one -- it runs where it is called, and those call sites
    // are in synchronous flow.
    //
    // An array method's callback is NOT deferred: `forEach` runs it there and then, inside the
    // same synchronous flow, so a publication in one is as safe as a publication beside it. Not
    // excluding them makes the guard redden on correct code -- measured, it did -- and a guard
    // that fails on the shape it is meant to allow gets deleted rather than obeyed.
    const SYNCHRONOUS_CALLBACKS = ["forEach", "map", "filter", "some", "every", "reduce", "sort"];

    function deferredBodies(text) {
        const bodies = [];
        const re = /([A-Za-z_$][\w$]*)?\s*[(,]\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)\s*\{/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            if (m[1] && SYNCHRONOUS_CALLBACKS.indexOf(m[1]) !== -1) { continue; }
            let depth = 0;
            let quote = null;
            const open = m.index + m[0].length - 1;
            for (let j = open; j < text.length; j += 1) {
                const c = text[j];
                if (quote) {
                    if (c === "\\") { j += 1; continue; }
                    if (c === quote) { quote = null; }
                    continue;
                }
                if (c === "\"" || c === "'" || c === "`") { quote = c; continue; }
                if (c === "{") { depth += 1; }
                else if (c === "}") {
                    depth -= 1;
                    if (depth === 0) { bodies.push(text.slice(open, j + 1)); break; }
                }
            }
        }
        return bodies;
    }

    const PUBLISH = "setInWindow('ABconsentCMP'";

    // Pinned both ways first: a scanner that finds no deferred body at all would report this
    // template clean without having looked at anything.
    [
        ["an installed function that republishes is seen",
            "setInWindow('oaiq', function(a) { setInWindow('ABconsentCMP', x, true); }, true);", 1],
        ["an injection callback that republishes is seen",
            "injectScript(u, function(){ setInWindow('ABconsentCMP', x, true); }, f);", 1],
        ["an arrow passed as an argument is seen",
            "reg('e', () => { setInWindow('ABconsentCMP', x, true); });", 1],
        ["a NAMED function is not a deferred body",
            "const f = function(a) { setInWindow('ABconsentCMP', x, true); };", 0],
        ["a named arrow is not one either",
            "const f = (a) => { setInWindow('ABconsentCMP', x, true); };", 0],
        ["a deferred body that reaches through the path instead is clean",
            "setInWindow('oaiq', function(a) { callInWindow('ABconsentCMP.openai.preQueue.push', a); }, true);", 0],
        ["a forEach callback is NOT deferred -- the false positive this cost",
            "rows.forEach(r => { setInWindow('ABconsentCMP', x, true); });", 0],
        ["and neither is a map one",
            "rows.map(function(r) { setInWindow('ABconsentCMP', x, true); });", 0],
        ["a callback on an unknown method still counts as deferred",
            "thing.onReady(function(r) { setInWindow('ABconsentCMP', x, true); });", 1]
    ].forEach((c) => {
        const hits = deferredBodies(c[1]).filter((b) => b.indexOf(PUBLISH) !== -1).length;
        check("deferred scanner: " + c[0], hits === c[2], String(hits));
    });

    const bodies = deferredBodies(code);
    check("the scanner reads the template's deferred bodies", bodies.length >= 3, String(bodies.length));

    const offenders = bodies.filter((b) => b.indexOf(PUBLISH) !== -1).length;
    check("no deferred body republishes the handoff object", offenders === 0, String(offenders));

    // The premise the whole thing rests on: read once. A second read would be a second snapshot,
    // and two snapshots written back in any order lose whichever was taken first.
    const reads = code.split("copyFromWindow('ABconsentCMP')").length - 1;
    check("the handoff object is read exactly once", reads === 1, String(reads));

    // And the publications are not decorative: each one follows a property being set, which is why
    // there are several rather than one at the end. Losing them all would leave the window object
    // without the handoff the served script reads.
    const writes = code.split(PUBLISH).length - 1;
    check("the handoff object is published at least once per property it carries",
        writes >= 6, String(writes));
}

// The scenarios shipped inside the template can actually run.
//
// WHY: those scenarios only execute in the GTM template editor, which nothing here can start, so
// they can rot without anyone noticing. They had: their mock data never set the field that opens
// the block emitting the defaults, so every assertion on it was made against an API that was never
// called. That was true before this branch too -- the mock data went on naming a field the form had
// renamed, which is the same rot one step earlier.
//
// This replays that mock data through the same fake APIs the rest of this file uses. It does not
// interpret the scenarios' own assertions; it checks the one thing whose absence made all of them
// meaningless -- that the run reaches the emission at all -- and pins what the declared table emits.
{
    const setup = TPL.split("setup: |-")[1];
    if (setup === undefined) { throw new Error("the template's test setup block is missing"); }

    // Top-level keys of the mock object, read as text: a rename in the form leaves them behind, and
    // a key no field declares is read as `undefined` by the template, silently.
    const mockKeys = [];
    setup.split("\n").forEach((line) => {
        const m = line.match(/^ {4}([A-Za-z_$][\w$]*):/);
        if (m) { mockKeys.push(m[1]); }
    });
    check("the template's mock data was found", mockKeys.length >= 4, mockKeys.join(","));

    // `parameters` and `flatten` are scoped to the form section above, so they are re-derived here
    // rather than hoisted: a shared mutable binding between two independent sections is how one
    // section's setup starts deciding another's verdict.
    const formParams = JSON.parse(extractJsonSection(
        "___TEMPLATE_PARAMETERS___", "___SANDBOXED_JS_FOR_WEB_TEMPLATE___"));
    const flat = (params) => params.reduce((all, param) =>
        all.concat([param], flat(param.subParams || [])), []);
    const declared = flat(formParams).map((param) => param.name);
    const undeclared = mockKeys.filter((key) => declared.indexOf(key) === -1);
    check("every key of the mock data names a declared field", undeclared.length === 0,
        undeclared.join(","));

    // The scenarios assert on the default emission, so the mock data has to open it. This is the
    // defect itself, stated as a rule.
    const assertsDefaults = TPL.indexOf("assertApi('setDefaultConsentState')") !== -1;
    check("the scenarios assert on the default emission", assertsDefaults);
    check("and the mock data opens it", mockKeys.indexOf("consentMode") !== -1, mockKeys.join(","));

    // Replayed: the declared table is applied as declared, which is what the first scenario says.
    const editor = run({sddan: SDDAN_LOCAL, data: {
        consentMode: true,
        overrideDefaultConsent: true,
        customConsentSettings: [{
            ad_storage: "denied", analytics_storage: "granted", personalization_storage: "granted",
            functionality_storage: "granted", security_storage: "granted",
            wait_for_update: 0, region: "ALL"
        }, {
            ad_storage: "denied", analytics_storage: "denied", personalization_storage: "denied",
            functionality_storage: "denied", security_storage: "denied",
            wait_for_update: 1000, region: "FR"
        }],
        url_passthrough: true, ads_data_redaction: false
    }});
    check("replaying the mock data emits the two declared rows", editor.calls.defaults.length === 2,
        JSON.stringify(editor.calls.defaults));
    check("the first carries no region and no wait, as the row says",
        editor.calls.defaults[0] && editor.calls.defaults[0].region === undefined &&
        editor.calls.defaults[0].wait_for_update === undefined &&
        editor.calls.defaults[0].analytics_storage === "granted" &&
        editor.calls.defaults[0].ad_user_data === "denied",
        JSON.stringify(editor.calls.defaults[0]));
    check("the second carries its region and its wait",
        editor.calls.defaults[1] &&
        JSON.stringify(editor.calls.defaults[1].region) === JSON.stringify(["FR"]) &&
        editor.calls.defaults[1].wait_for_update === 1000 &&
        editor.calls.defaults[1].ad_storage === "denied",
        JSON.stringify(editor.calls.defaults[1]));
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
