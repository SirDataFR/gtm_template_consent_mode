// Harnais de vérification du JS sandboxé de ce template (FRONT-1314).
//
// POURQUOI il existe : la section `___TESTS___` du .tpl ne s'exécute que dans l'éditeur GTM, et
// elle n'atteint en pratique que le chemin du `default` — le listener `onUserChoice`, la
// déduplication des updates et l'écriture de `__sdgcm` lui échappent. Ce dépôt n'ayant aucune CI,
// ce fichier est le seul contrôle mécanique du comportement.
//
//     node tests/sandbox-harness.js
//
// Il extrait le JS du .tpl et le rejoue avec de faux APIs GTM. Ce n'est PAS le bac à sable de
// Google : il ne vérifie ni les permissions, ni les restrictions du sous-ensemble de JS. Il
// vérifie le comportement, ce qu'aucun autre contrôle local ne fait.
const path = require("path");
const fs = require("fs");

const TPL = fs.readFileSync(path.join(__dirname, "..", "template.tpl"), "utf8");
const SRC = TPL.split("___SANDBOXED_JS_FOR_WEB_TEMPLATE___")[1].split("___WEB_PERMISSIONS___")[0];

function run(opts) {
    const cookies = Object.assign({}, opts.cookies || {});
    const calls = {defaults: [], updates: [], setCookies: []};
    let listener = null;
    const globals = {SDDAN: opts.sddan};

    const api = {
        callInWindow: (name, method, _v, fn) => { if (name === "__sdcmpapi" && method === "addEventListener") listener = fn; },
        gtagSet: () => {},
        logToConsole: () => {},
        makeTableMap: () => ({}),
        setDefaultConsentState: (o) => calls.defaults.push(JSON.parse(JSON.stringify(o))),
        updateConsentState: (o) => calls.updates.push(JSON.parse(JSON.stringify(o))),
        injectScript: (_u, ok) => ok && ok(),
        encodeUriComponent: encodeURIComponent,
        makeInteger: (v) => parseInt(v, 10),
        getCookieValues: (name) => (cookies[name] === undefined ? [] : [cookies[name]]),
        setCookie: (name, value, options, encode) => {
            calls.setCookies.push({name, value, options, encode});
            cookies[name] = value;
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
        if (!(n in api)) throw new Error("API non stubée : " + n);
        return api[n];
    });

    return {calls, listener, cookies};
}

const TC_ALL_GRANTED = {
    gdprApplies: true, eventStatus: "useractioncomplete",
    purpose: {consents: {1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 8: true}, legitimateInterests: {}},
    vendor: {consents: {755: true}, legitimateInterests: {}}
};
// Seule la finalité 1 est accordée : ni la 8 (analytics), ni les 5/6 (personalization), ni le
// vendor 755 (les trois ad_*). Sert à vérifier qu'un changement repousse bien un update.
const TC_ONLY_P1 = {
    gdprApplies: true, eventStatus: "useractioncomplete",
    purpose: {consents: {1: true}, legitimateInterests: {}},
    vendor: {consents: {}, legitimateInterests: {}}
};

// Rien n'est accordé : l'objet émis vaut alors exactement le default tout-refusé de la table de
// réglages. C'est le cas qui doit NE PAS repousser d'update.
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
function check(label, cond, detail) {
    if (cond) { console.log("  ok   " + label); }
    else { failures++; console.log("  FAIL " + label + (detail ? "  -> " + detail : "")); }
}

console.log("\n1. Sans aucun cookie : comportement identique à avant");
{
    const r = run({sddan: SDDAN_LOCAL});
    check("un default posé", r.calls.defaults.length === 1);
    check("default tout refusé", r.calls.defaults[0].ad_storage === "denied" && r.calls.defaults[0].analytics_storage === "denied");
    check("wait_for_update conservé à 1000", r.calls.defaults[0].wait_for_update === 1000, JSON.stringify(r.calls.defaults[0]));
    r.listener(TC_ALL_GRANTED, true);
    check("un update poussé", r.calls.updates.length === 1);
    check("cookie __sdgcm écrit", r.calls.setCookies.length === 1 && r.calls.setCookies[0].name === "__sdgcm");
    check("bits = tout accordé", r.calls.setCookies[0].value === "1.1111111", r.calls.setCookies[0].value);
    check("path/max-age/samesite", r.calls.setCookies[0].options["max-age"] === 390 * 86400 && r.calls.setCookies[0].options.path === "/" && r.calls.setCookies[0].options.samesite === "Lax");
    check("encode=false", r.calls.setCookies[0].encode === false);
}

console.log("\n2. __sdgcm + cookie de consentement : le default vient du cookie");
{
    const r = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "1.1111111", "euconsent-v2": "CP..."}});
    check("default tout accordé", r.calls.defaults[0].ad_storage === "granted" && r.calls.defaults[0].analytics_storage === "granted", JSON.stringify(r.calls.defaults[0]));
    check("wait_for_update = 0", r.calls.defaults[0].wait_for_update === 0);
    r.listener(TC_ALL_GRANTED, true);
    check("AUCUN update (dédup)", r.calls.updates.length === 0, JSON.stringify(r.calls.updates));
    check("cookie tout de même réécrit", r.calls.setCookies.length === 1 && r.calls.setCookies[0].value === "1.1111111");
}

console.log("\n3. __sdgcm mixte : le default le reflète signal par signal");
{
    // ordre v1 : analytics, functionality, security, personalization, ad_storage, ad_user_data, ad_personalization
    const r = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "1.1010000", "sdconsent-v2": "x"}});
    const d = r.calls.defaults[0];
    check("analytics accordé", d.analytics_storage === "granted", JSON.stringify(d));
    check("functionality refusé", d.functionality_storage === "denied");
    check("security accordé", d.security_storage === "granted");
    check("ad_storage refusé", d.ad_storage === "denied");
    check("via sdconsent-v2 aussi", d.wait_for_update === 0);
}

console.log("\n4. Gardes : le cookie est ignoré et rien ne change");
{
    const cases = {
        "sans cookie de consentement": {"__sdgcm": "1.1111111"},
        "version inconnue": {"__sdgcm": "2.1111111", "euconsent-v2": "x"},
        "trop court": {"__sdgcm": "1.111111", "euconsent-v2": "x"},
        "trop long": {"__sdgcm": "1.11111111", "euconsent-v2": "x"},
        "caractère hors 0/1": {"__sdgcm": "1.111111x", "euconsent-v2": "x"},
        "sans version": {"__sdgcm": "1111111", "euconsent-v2": "x"},
        "vide": {"__sdgcm": "", "euconsent-v2": "x"}
    };
    for (const label in cases) {
        const r = run({sddan: SDDAN_LOCAL, cookies: cases[label]});
        const d = r.calls.defaults[0];
        check(label, d.ad_storage === "denied" && d.wait_for_update === 1000, JSON.stringify(d));
    }
}

console.log("\n5. Déduplication de l'update");
{
    const r = run({sddan: SDDAN_LOCAL});
    r.listener(TC_ALL_GRANTED, true);
    r.listener(TC_ALL_GRANTED, true);
    check("deux événements identiques -> un seul update", r.calls.updates.length === 1, JSON.stringify(r.calls.updates));
    check("mais le cookie est réécrit à chaque fois", r.calls.setCookies.length === 2);
    r.listener(TC_ONLY_P1, true);
    check("un changement repousse un update", r.calls.updates.length === 2);
    // Seule la finalité 1 est accordée : functionality et security passent, mais analytics exige
    // aussi la finalité 8, et tous les ad_* le vendor 755. D'où 0,1,1,0,0,0,0.
    check("et le cookie suit", r.calls.setCookies[2].value === "1.0110000", r.calls.setCookies[2].value);
}

console.log("\n6. Portée GROUP/PROVIDER : rien n'est persisté");
{
    const r = run({sddan: SDDAN_GROUP});
    r.listener(TC_ALL_GRANTED, true);
    check("update poussé", r.calls.updates.length === 1);
    check("aucun cookie écrit", r.calls.setCookies.length === 0, JSON.stringify(r.calls.setCookies));
}

console.log("\n7. SDDAN absent : on ne persiste pas, le reste est inchangé");
{
    const r = run({sddan: undefined});
    r.listener(TC_ALL_GRANTED, true);
    check("update poussé", r.calls.updates.length === 1);
    check("aucun cookie écrit", r.calls.setCookies.length === 0);
}

console.log("\n8. Signal 'not used' : absent du default et de l'update, present dans le cookie");
{
    const r = run({
        sddan: SDDAN_LOCAL,
        data: {settingsTable: [{
            ad_storage: "not used", analytics_storage: "denied", personalization_storage: "denied",
            functionality_storage: "denied", security_storage: "denied", wait_for_update: 1000, region: "ALL"
        }]},
        cookies: {"__sdgcm": "1.1111111", "euconsent-v2": "x"}
    });
    check("ad_storage absent du default", r.calls.defaults[0].ad_storage === undefined, JSON.stringify(r.calls.defaults[0]));
    check("analytics vient du cookie", r.calls.defaults[0].analytics_storage === "granted");
    r.listener(TC_ALL_GRANTED, true);
    check("cookie porte quand meme ad_storage vrai", r.calls.setCookies[0].value === "1.1111111", r.calls.setCookies[0].value);
}

console.log("\n9. SANS cookie, choix identique au default : aucun update");
{
    // Le default EST une poussée : un update qui le répète n'apprend rien à gtag. Avant le
    // correctif, lastPushedSignals n'était amorcé que depuis le cookie, donc ce cas — de loin le
    // plus fréquent, un visiteur qui refuse sur sa première page vue — repoussait un update
    // identique à CHAQUE page vue.
    const r = run({sddan: SDDAN_LOCAL});
    check("default tout refusé", r.calls.defaults[0].ad_storage === "denied");
    r.listener(TC_ALL_DENIED, true);
    check("AUCUN update (identique au default)", r.calls.updates.length === 0, JSON.stringify(r.calls.updates));
    check("mais le cookie est bien écrit", r.calls.setCookies.length === 1 && r.calls.setCookies[0].value === "1.0000000", JSON.stringify(r.calls.setCookies));
    // La décision 2 reste indépendante de la décision 1 : le cookie s'écrit sans qu'un update parte.
    r.listener(TC_ALL_GRANTED, true);
    check("un vrai changement repousse un update", r.calls.updates.length === 1);
}

console.log("\n10. Lignes régionales divergentes : le signal ambigu repart en update");
{
    // gtag applique la ligne FR aux visiteurs FR et la ligne ALL aux autres — le template ne sait
    // pas laquelle ce visiteur a reçue. Sauter l'update sur une supposition laisserait les tags
    // tourner sous un état qu'il n'a pas choisi : l'ambigu doit donc repartir.
    const r = run({
        sddan: SDDAN_LOCAL,
        data: {settingsTable: [row({region: "ALL"}), row({analytics_storage: "granted", region: "FR"})]}
    });
    check("deux defaults posés", r.calls.defaults.length === 2);
    r.listener(TC_ALL_DENIED, true);
    check("update poussé malgré l'égalité apparente", r.calls.updates.length === 1, JSON.stringify(r.calls.updates));
}

console.log("\n11. Aucune ligne globale : on n'amorce rien");
{
    // Une table qui n'a que des lignes régionales ne pose AUCUN default aux visiteurs hors de ces
    // régions. On ne peut donc rien affirmer sur ce qu'ils ont reçu.
    const r = run({sddan: SDDAN_LOCAL, data: {settingsTable: [row({region: "FR"})]}});
    check("le default porte bien une région", r.calls.defaults[0].region[0] === "FR", JSON.stringify(r.calls.defaults[0]));
    r.listener(TC_ALL_DENIED, true);
    check("update poussé (rien d'amorcé)", r.calls.updates.length === 1, JSON.stringify(r.calls.updates));
}

console.log(failures === 0 ? "\nTOUT VERT" : "\n" + failures + " ECHEC(S)");
process.exit(failures === 0 ? 0 : 1);
