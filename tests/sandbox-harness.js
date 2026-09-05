// Behaviour harness for this template's sandboxed JS.
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

// L'extraction est le SEUL point où ce harnais peut mentir en silence : si un délimiteur changeait,
// on rejouerait un fragment — voire du vide — et tous les contrôles passeraient au vert sans avoir
// rien exercé. Un contrôle qui ne peut pas échouer ne contrôle rien, donc on vérifie que le
// découpage a bien rendu le corps attendu et on jette bruyamment sinon.
function extractSandboxedJs(tpl) {
    const OPEN = "___SANDBOXED_JS_FOR_WEB_TEMPLATE___";
    const CLOSE = "___WEB_PERMISSIONS___";
    const parts = tpl.split(OPEN);
    if (parts.length !== 2) {
        throw new Error("delimiteur " + OPEN + " absent ou en double (" + parts.length + " morceaux)");
    }
    if (parts[1].indexOf(CLOSE) === -1) {
        throw new Error("delimiteur " + CLOSE + " absent apres " + OPEN);
    }
    const src = parts[1].split(CLOSE)[0];
    // Sentinelles : des symboles que le corps sandboxé DOIT porter. Leur absence signifie qu'on a
    // découpé au mauvais endroit — pas que le template a un bug.
    ["setDefaultConsentState", "updateConsentState", "CONSENT_MODE_SIGNALS", "onUserChoice"].forEach((s) => {
        if (src.indexOf(s) === -1) {
            throw new Error("corps sandboxe suspect : '" + s + "' introuvable");
        }
    });
    if (src.length < 2000) {
        throw new Error("corps sandboxe suspect : " + src.length + " octets");
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
        // L'URL est ENREGISTRÉE, pas seulement le rappel exécuté : sans ça aucun test ne peut
        // assérer que la CMP est bien chargée, seulement que rien n'a planté.
        injectScript: (u, ok) => { calls.injected.push(u); if (ok) { ok(); } },
        encodeUriComponent: encodeURIComponent,
        makeInteger: (v) => parseInt(v, 10),
        getCookieValues: (name) => (cookies[name] === undefined ? [] : [cookies[name]]),
        setCookie: (name, value, options, encode) => {
            calls.setCookies.push({name, value, options, encode});
            // `max-age: -1` est l'instruction de SUPPRESSION, pas une écriture. Le stub l'honore
            // pour que le pot reflète l'état réel du navigateur : sans ça, aucun test ne peut
            // assérer qu'un cookie SURVIT à l'événement, seulement compter des appels.
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
let checksRun = 0;
function check(label, cond, detail) {
    checksRun++;
    if (cond) { console.log("  ok   " + label); }
    else { failures++; console.log("  FAIL " + label + (detail ? "  -> " + detail : "")); }
}

// Les noms des cookies que `deleteCookie` a réellement effacés. Il écrit plusieurs fois le même
// nom (un par domaine remonté), d'où le dédoublonnage ; le marqueur est `max-age: -1`, seul
// endroit du template qui l'emploie.
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

// Un tcData qui n'accorde RIEN et porte de quoi déclencher la suppression : c'est l'absence de
// consentement à la finalité 1 qui l'ouvre.
function purgeEvent(cookieList) {
    return {
        gdprApplies: true, eventStatus: "useractioncomplete",
        purpose: {consents: {}, legitimateInterests: {}},
        vendor: {consents: {}, legitimateInterests: {}},
        hostName: "www.example.com", cookieList: cookieList
    };
}

console.log("\n1. Sans aucun cookie : comportement identique à avant");
{
    const r = run({sddan: SDDAN_LOCAL});
    check("un default posé", r.calls.defaults.length === 1);
    check("default tout refusé", r.calls.defaults[0].ad_storage === "denied" && r.calls.defaults[0].analytics_storage === "denied");
    check("wait_for_update conservé à 1000", r.calls.defaults[0].wait_for_update === 1000, JSON.stringify(r.calls.defaults[0]));
    r.listener(TC_ALL_GRANTED, true);
    check("un update poussé", r.calls.updates.length === 1);
    check("AUCUN cookie écrit", r.calls.setCookies.length === 0, JSON.stringify(r.calls.setCookies));
}

console.log("\n2. __sdgcm + cookie de consentement : le default vient du cookie");
{
    const r = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "1.1111111", "euconsent-v2": "CP..."}});
    check("default tout accordé", r.calls.defaults[0].ad_storage === "granted" && r.calls.defaults[0].analytics_storage === "granted", JSON.stringify(r.calls.defaults[0]));
    check("wait_for_update = 0", r.calls.defaults[0].wait_for_update === 0);
    r.listener(TC_ALL_GRANTED, true);
    check("AUCUN update (dédup)", r.calls.updates.length === 0, JSON.stringify(r.calls.updates));
    check("et toujours aucune écriture", r.calls.setCookies.length === 0);

    // Le cookie est lu SANS condition sur ce qui l'entoure, et c'est l'invariant à tenir. Une
    // forme antérieure exigeait un enregistrement de consentement à côté — `euconsent-v2`,
    // `sdconsent-v2` ou `usprivacy` — mais la liste ne peut pas être complète depuis ici : quel
    // enregistrement est écrit dépend de la configuration (régulation applicable, API coupée),
    // que le template ne voit pas. Toute combinaison non nommée se lisait « aucun choix », donc
    // tout-refusé avec `wait_for_update`, à chaque page vue et sans le moindre signal.
    //
    // Les deux cas ci-dessous sont les DEUX côtés de ce retrait : avec un enregistrement, et sans
    // aucun. Ils doivent rendre la même chose.
    const us = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:1111111", "usprivacy": "1YNN"}});
    check("chemin US — le cookie est lu", us.calls.defaults[0].analytics_storage === "granted" &&
        us.calls.defaults[0].wait_for_update === 0, JSON.stringify(us.calls.defaults[0]));

    const seul = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:1111111"}});
    check("SANS aucun enregistrement à côté — lu quand même",
        seul.calls.defaults[0].analytics_storage === "granted" &&
        seul.calls.defaults[0].wait_for_update === 0,
        JSON.stringify(seul.calls.defaults[0]));
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
    check("plus rien à attendre", d.wait_for_update === 0);
}

console.log("\n4. Gardes : une chaîne MALFORMÉE est ignorée et rien ne change");
{
    // A higher version and a longer bit string are NOT rejections -- they are the definition of a
    // newer format, and they are covered in section 13. What stays here is what must keep being
    // rejected: a string we cannot read, not a version we do not know.
    const cases = {
        "trop court": {"__sdgcm": "1.111111", "euconsent-v2": "x"},
        "caractère hors 0/1 dans les 7 premiers": {"__sdgcm": "1.111111x", "euconsent-v2": "x"},
        "sans version": {"__sdgcm": "1111111", "euconsent-v2": "x"},
        "vide": {"__sdgcm": "", "euconsent-v2": "x"},
        // split('.') yields three segments here; reading only two would be interpreting sideways
        // a string we do not understand.
        "segments en trop": {"__sdgcm": "1.1111111.0", "euconsent-v2": "x"},
        "version zéro": {"__sdgcm": "0.1111111", "euconsent-v2": "x"},
        "version non numérique": {"__sdgcm": "v2.1111111", "euconsent-v2": "x"},
        "version vide": {"__sdgcm": ".1111111", "euconsent-v2": "x"},
        // parseInt('1x') vaut 1 : sans validation chiffre par chiffre, celle-ci passerait.
        "version numérique + suffixe": {"__sdgcm": "1x.1111111", "euconsent-v2": "x"}
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
    check("et rien n'est écrit", r.calls.setCookies.length === 0);
    r.listener(TC_ONLY_P1, true);
    check("un changement repousse un update", r.calls.updates.length === 2);
    // Seule la finalité 1 est accordée : functionality et security passent, mais analytics exige
    // aussi la finalité 8, et tous les ad_* le vendor 755. D'où 0,1,1,0,0,0,0.
    check("et le second update porte le nouvel état",
        r.calls.updates[1].analytics_storage === "denied", JSON.stringify(r.calls.updates[1]));
}

console.log("\n6. Le template n'ÉCRIT JAMAIS ce cookie — quelle que soit la portée");
{
    // Un seul producteur, un seul consommateur. Le script de consentement qui sert la page
    // possède le cookie ; le template le LIT pour son default et pousse les `update`. Deux
    // producteurs sur le même segment, ce sont deux dérivations qui ne coïncident pas — ce
    // template tire `ad_user_data` du seul vendor 755 — donc une valeur qui bascule d'une page
    // vue à l'autre selon qui a écrit en dernier.
    const cas = [
        ["portée LOCAL", {sddan: SDDAN_LOCAL}],
        ["portée GROUP", {sddan: SDDAN_GROUP}],
        ["SDDAN absent", {sddan: undefined}],
        ["cookie déjà présent", {sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:0000000", "euconsent-v2": "x"}}]
    ];
    for (let i = 0; i < cas.length; i++) {
        const r = run(cas[i][1]);
        r.listener(TC_ALL_GRANTED, true);
        check(cas[i][0] + " : aucune écriture", r.calls.setCookies.length === 0,
            JSON.stringify(r.calls.setCookies));
    }

    // TÉMOIN, et il est load-bearing : sans lui, un template qui ne ferait plus RIEN du tout
    // satisferait les quatre assertions ci-dessus.
    const temoin = run({sddan: SDDAN_LOCAL});
    temoin.listener(TC_ALL_GRANTED, true);
    check("témoin — il pousse toujours son default et son update",
        temoin.calls.defaults.length === 1 && temoin.calls.updates.length === 1);
}

console.log("\n7. Signal 'not used' : absent du default comme de l'update");
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
    check("et rien n'est écrit", r.calls.setCookies.length === 0);
}

console.log("\n8. SANS cookie, choix identique au default : aucun update");
{
    // Le default EST une poussée : un update qui le répète n'apprend rien à gtag. Avant le
    // correctif, lastPushedSignals n'était amorcé que depuis le cookie, donc ce cas — de loin le
    // plus fréquent, un visiteur qui refuse sur sa première page vue — repoussait un update
    // identique à CHAQUE page vue.
    const r = run({sddan: SDDAN_LOCAL});
    check("default tout refusé", r.calls.defaults[0].ad_storage === "denied");
    r.listener(TC_ALL_DENIED, true);
    check("AUCUN update (identique au default)", r.calls.updates.length === 0, JSON.stringify(r.calls.updates));
    check("et rien n'est écrit", r.calls.setCookies.length === 0);
    // La décision 2 reste indépendante de la décision 1 : le cookie s'écrit sans qu'un update parte.
    r.listener(TC_ALL_GRANTED, true);
    check("un vrai changement repousse un update", r.calls.updates.length === 1);
}

console.log("\n9. Lignes régionales divergentes : le signal ambigu repart en update");
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

console.log("\n10. Aucune ligne globale : on n'amorce rien");
{
    // Une table qui n'a que des lignes régionales ne pose AUCUN default aux visiteurs hors de ces
    // régions. On ne peut donc rien affirmer sur ce qu'ils ont reçu.
    const r = run({sddan: SDDAN_LOCAL, data: {settingsTable: [row({region: "FR"})]}});
    check("le default porte bien une région", r.calls.defaults[0].region[0] === "FR", JSON.stringify(r.calls.defaults[0]));
    r.listener(TC_ALL_DENIED, true);
    check("update poussé (rien d'amorcé)", r.calls.updates.length === 1, JSON.stringify(r.calls.updates));
}

console.log("\n11. 'not used' sur UNE ligne seulement : le signal non émis doit repartir");
{
    // La ligne globale marque ad_storage « not used », la ligne FR l'émet. Un visiteur HORS de FR
    // n'a donc reçu aucun default pour ad_storage — alors que l'update, lui, l'émet (defaultConsent
    // est un accumulateur global : une seule ligne qui l'utilise suffit à le poser à 'denied').
    //
    // Amorcer ad_storage depuis le cookie ferait croire que gtag le connaît déjà et supprimerait
    // l'update. L'état gtag ne survit PAS d'une page vue à l'autre : ce visiteur n'aurait jamais
    // reçu ad_storage, et ses tags resteraient éteints malgré un consentement accordé.
    const r = run({
        sddan: SDDAN_LOCAL,
        data: {settingsTable: [row({ad_storage: "not used", region: "ALL"}), row({region: "FR"})]},
        cookies: {"__sdgcm": "1.1111111", "euconsent-v2": "x"}
    });
    check("ad_storage absent du default global", r.calls.defaults[0].ad_storage === undefined, JSON.stringify(r.calls.defaults[0]));
    check("mais présent sur la ligne FR", r.calls.defaults[1].ad_storage === "granted", JSON.stringify(r.calls.defaults[1]));
    r.listener(TC_ALL_GRANTED, true);
    check("update poussé (ad_storage jamais posé en default)", r.calls.updates.length === 1, JSON.stringify(r.calls.updates));
}

console.log("\n12. Conteneur segmenté : on ne lit que le segment qu'on possède");
{
    // Le cookie porte un segment par mode de consentement, indexé par son id. Ce template ne
    // possède que `g` ; les autres appartiennent à d'autres composants.
    const complet = run({sddan: SDDAN_LOCAL,
        cookies: {"__sdgcm": "2.g:1:1111111~m:1:1~o:1:0", "euconsent-v2": "x"}});
    check("le segment g est lu au milieu des autres",
        complet.calls.defaults[0].ad_storage === "granted" && complet.calls.defaults[0].wait_for_update === 0,
        JSON.stringify(complet.calls.defaults[0]));

    // LE cas que l'ancien format ne savait pas dire : un cookie sans aucun segment Google.
    // Segment ABSENT = non décidé, donc repli sur la configuration — surtout pas sept zéros.
    const sansG = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.m:1:1~o:1:0", "euconsent-v2": "x"}});
    check("segment g ABSENT -> non décidé, repli sur la config",
        sansG.calls.defaults[0].analytics_storage === "denied" && sansG.calls.defaults[0].wait_for_update === 1000,
        JSON.stringify(sansG.calls.defaults[0]));

    // ... à distinguer d'un g présent dont tous les bits sont à zéro, qui est une DÉCISION.
    const zeros = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:0000000", "euconsent-v2": "x"}});
    check("segment g à ZÉRO -> décidé, tout refusé",
        zeros.calls.defaults[0].analytics_storage === "denied" && zeros.calls.defaults[0].wait_for_update === 0,
        JSON.stringify(zeros.calls.defaults[0]));

    // L'ordre ne veut rien dire : on splitte sur ~ et on cherche l'id.
    const avant = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:1010000~m:1:1", "euconsent-v2": "x"}});
    const apres = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.m:1:1~g:1:1010000", "euconsent-v2": "x"}});
    check("l'ordre des segments ne change rien",
        JSON.stringify(avant.calls.defaults[0]) === JSON.stringify(apres.calls.defaults[0]),
        JSON.stringify(apres.calls.defaults[0]));

    // Doublon d'id : la dernière occurrence gagne.
    const doublon = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:1:1111111~g:1:0000000", "euconsent-v2": "x"}});
    check("sur doublon, la DERNIÈRE occurrence gagne",
        doublon.calls.defaults[0].analytics_storage === "denied", JSON.stringify(doublon.calls.defaults[0]));

    // Version de segment supérieure : les bits sont appendés, on lit les sept premiers. C'est ce
    // qui permet au format de s'étendre sans que ce template soit republié.
    const v2 = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.g:2:101000011~m:1:1", "euconsent-v2": "x"}});
    const d = v2.calls.defaults[0];
    check("version de segment supérieure : analytics lu", d.analytics_storage === "granted", JSON.stringify(d));
    check("version de segment supérieure : functionality lu", d.functionality_storage === "denied");
    check("version de segment supérieure : security lu", d.security_storage === "granted");

    // Un champ structurellement cassé est écarté SEUL.
    const casse = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "2.casse~g:1:1010000", "euconsent-v2": "x"}});
    check("un champ cassé n'empêche pas de lire g",
        casse.calls.defaults[0].analytics_storage === "granted", JSON.stringify(casse.calls.defaults[0]));

    // L'ancien format reste lu, migré en segment g.
    const herite = run({sddan: SDDAN_LOCAL, cookies: {"__sdgcm": "1.1010000", "euconsent-v2": "x"}});
    check("l'ancien format est toujours lu",
        herite.calls.defaults[0].analytics_storage === "granted" && herite.calls.defaults[0].wait_for_update === 0,
        JSON.stringify(herite.calls.defaults[0]));
}

console.log("\n13. Global Privacy Control takes precedence in the default");
{
    // Une ligne où TOUT est accordé : sans elle, le refus GPC serait indistinguable du default
    // tout-refusé de la table, et le contrôle ne contrôlerait rien.
    const ALL_GRANTED_ROW = {
        ad_storage: "granted", analytics_storage: "granted", personalization_storage: "granted",
        functionality_storage: "granted", security_storage: "granted",
        wait_for_update: 1000, region: "ALL"
    };
    const GRANTED = {settingsTable: [ALL_GRANTED_ROW]};
    // FABRIQUE, jamais une constante partagée : la règle US MUTE son argument
    // (`tcData.gdprApplies = true`). Un objet réutilisé d'un cas au suivant arrive donc avec
    // gdprApplies déjà vrai, le garde d'entrée d'`onUserChoice` le rejette faute de `purpose`,
    // et le cas rend zéro update — ce qui se lit exactement comme le résultat attendu d'un
    // discriminant. Payé ici : le discriminant plus bas passait pour cette raison.
    const usEvent = () => ({gdprApplies: false, eventStatus: "useractioncomplete"});

    // Témoin : sans marqueur, la ligne passe telle quelle. C'est lui qui rend le reste lisible.
    const off = run({sddan: SDDAN_LOCAL, data: GRANTED});
    check("témoin — sans marqueur, ad_storage accordé", off.calls.defaults[0].ad_storage === "granted");
    check("témoin — wait_for_update conservé", off.calls.defaults[0].wait_for_update === 1000);

    // CINQ refusés, DEUX conservés. Une opposition à la vente n'est pas un refus du strictement
    // nécessaire : couper security_storage casserait l'authentification et l'anti-fraude.
    const on = run({sddan: SDDAN_LOCAL, data: GRANTED, cookies: {"__gpcactive": "1"}});
    const g = on.calls.defaults[0];
    check("ad_storage refusé", g.ad_storage === "denied", JSON.stringify(g));
    check("analytics_storage refusé", g.analytics_storage === "denied");
    check("personalization_storage refusé", g.personalization_storage === "denied");
    check("ad_user_data refusé", g.ad_user_data === "denied");
    check("ad_personalization refusé", g.ad_personalization === "denied");
    check("functionality_storage CONSERVÉ", g.functionality_storage === "granted");
    check("security_storage CONSERVÉ", g.security_storage === "granted");
    check("plus rien à attendre", g.wait_for_update === 0);

    // LA règle de précédence : le GPC gagne sur __sdgcm, quoi que celui-ci dise.
    const both = run({
        sddan: SDDAN_LOCAL, data: GRANTED,
        cookies: {"__sdgcm": "1.1111111", "euconsent-v2": "x", "__gpcactive": "1"}
    });
    const b = both.calls.defaults[0];
    check("GPC gagne sur un __sdgcm tout accordé", b.ad_storage === "denied", JSON.stringify(b));
    check("et les deux conservés viennent du cookie", b.functionality_storage === "granted");

    // La combinaison que le retrait du garde rend atteignable : un `__sdgcm` tout accordé SANS
    // aucun enregistrement à côté. Le cookie est désormais lu, donc l'objection doit encore
    // gagner — sinon le retrait aurait ouvert un chemin où un GPC actif sert du tout-accordé.
    const gpcSurCookieSeul = run({
        sddan: SDDAN_LOCAL, data: GRANTED,
        cookies: {"__sdgcm": "1.1111111", "__gpcactive": "1"}
    });
    const gs = gpcSurCookieSeul.calls.defaults[0];
    check("GPC gagne sur un __sdgcm SANS enregistrement", gs.ad_storage === "denied" &&
        gs.analytics_storage === "denied" && gs.ad_user_data === "denied" &&
        gs.ad_personalization === "denied" && gs.personalization_storage === "denied",
        JSON.stringify(gs));
    check("et les deux conservés le restent", gs.functionality_storage === "granted" &&
        gs.security_storage === "granted", JSON.stringify(gs));

    // NO eligibility guard: no consent cookie needed. That is the point -- gating this on a value
    // that is only correct per cached response would ignore GPC for many US visitors.
    const bare = run({sddan: SDDAN_LOCAL, data: GRANTED, cookies: {"__gpcactive": "1"}});
    check("honoré sans aucun cookie de consentement", bare.calls.defaults[0].ad_storage === "denied");

    // The marker is REMOVED rather than set to '0', so any value other than '1' would be a
    // sideways reading and is ignored.
    const zero = run({sddan: SDDAN_LOCAL, data: GRANTED, cookies: {"__gpcactive": "0"}});
    check("une valeur autre que '1' est ignorée", zero.calls.defaults[0].ad_storage === "granted",
        JSON.stringify(zero.calls.defaults[0]));

    // Chemin US de l'UPDATE. Le marqueur apparaît entre le default et l'événement : c'est ce qui
    // isole le chemin de l'update de celui du default, sinon la déduplication supprimerait
    // l'update (le default aurait déjà dit la même chose) et le test ne prouverait rien.
    const upd = run({sddan: SDDAN_LOCAL, data: GRANTED});
    upd.cookies["__gpcactive"] = "1";
    upd.listener(usEvent(), true);
    check("un update part sur le chemin US", upd.calls.updates.length === 1, JSON.stringify(upd.calls.updates));
    const u = upd.calls.updates[0];
    check("update — ad_storage refusé", u.ad_storage === "denied", JSON.stringify(u));
    check("update — analytics refusé", u.analytics_storage === "denied");
    check("update — functionality conservé", u.functionality_storage === "granted");
    check("update — security conservé", u.security_storage === "granted");

    // Discriminant : le même événement US SANS marqueur ni chaîne opposée ne refuse rien. Sans
    // lui, le contrôle ci-dessus passerait même si le marqueur n'était jamais lu.
    // On assère la VALEUR, pas l'absence d'update : « zéro update » est ce que rend aussi un
    // événement rejeté au garde d'entrée, donc l'accepter ne prouverait rien.
    const noGpc = run({sddan: SDDAN_LOCAL, data: GRANTED});
    noGpc.listener(usEvent(), true);
    check("discriminant — sans marqueur, ad_storage reste accordé",
        noGpc.calls.updates.length === 1 && noGpc.calls.updates[0].ad_storage === "granted",
        JSON.stringify(noGpc.calls.updates));

    // La chaîne usprivacy opposée continue de fonctionner : le marqueur s'AJOUTE à la règle
    // existante, il ne la remplace pas.
    // `__uspapi` doit exister EN FONCTION : c'est la porte de la branche usprivacy, et sans elle
    // ce chemin est inatteignable — il ne l'avait jamais été depuis ce harnais.
    const usp = run({
        sddan: SDDAN_LOCAL, data: GRANTED,
        cookies: {"usprivacy": "1YYN"}, globals: {"__uspapi": () => {}}
    });
    usp.listener(usEvent(), true);
    check("usprivacy opposée toujours honorée",
        usp.calls.updates.length === 1 && usp.calls.updates[0].ad_storage === "denied",
        JSON.stringify(usp.calls.updates));
}

console.log("\n14. Exclusion mutuelle : qui POUSSE les update dans la dataLayer");
{
    // L'invariant le plus load-bearing du fichier, et il n'était couvert par RIEN. Le template
    // claims Consent Mode by setting `ABconsentCMP.enableConsentMode = false`; the CMP script
    // registers its own listener only when that flag is TRUE. The two derivations are not
    // identical -- this template takes ad_user_data from vendor 755 alone -- so two simultaneous
    // writers would contradict each other from one page view to the next.
    //
    // Témoin d'abord : sans le drapeau, tout part normalement. Sans lui, un template qui ne
    // ferait plus rien du tout satisferait les trois assertions suivantes.
    const claimed = run({sddan: SDDAN_LOCAL});
    claimed.listener(TC_ALL_GRANTED, true);
    check("témoin — sans le drapeau, le template mène", claimed.calls.defaults.length === 1 &&
        claimed.calls.updates.length === 1 && claimed.calls.setCookies.length === 0);

    const ceded = run({sddan: SDDAN_LOCAL, globals: {ABconsentCMP: {enableConsentMode: true}}});
    check("aucun default posé", ceded.calls.defaults.length === 0, JSON.stringify(ceded.calls.defaults));
    check("le listener est tout de même enregistré", typeof ceded.listener === "function");
    ceded.listener(TC_ALL_GRANTED, true);
    check("aucun update poussé", ceded.calls.updates.length === 0, JSON.stringify(ceded.calls.updates));
    check("et toujours aucune écriture", ceded.calls.setCookies.length === 0, JSON.stringify(ceded.calls.setCookies));

    // Le drapeau à `false` est le cas du template qui a DÉJÀ revendiqué le Consent Mode sur une
    // exécution précédente : il doit continuer de mener, pas se taire.
    const reclaimed = run({sddan: SDDAN_LOCAL, globals: {ABconsentCMP: {enableConsentMode: false}}});
    check("drapeau à false : le template mène toujours", reclaimed.calls.defaults.length === 1,
        JSON.stringify(reclaimed.calls.defaults));

    // La suppression de cookies n'est PAS du Consent Mode : elle ne dépend pas de l'exclusion et
    // must keep working when the CMP script is the one leading.
    const purge = run({
        sddan: SDDAN_LOCAL,
        globals: {ABconsentCMP: {enableConsentMode: true}},
        data: {handleCookiesDeletion: true},
        cookies: {"_ga": "x"}
    });
    purge.listener(purgeEvent("_ga"), true);
    check("mais la suppression de cookies reste active", deletedNames(purge.calls).indexOf("_ga") !== -1,
        JSON.stringify(deletedNames(purge.calls)));
}

console.log("\n15. Suppression de cookies : les quatre règles de préservation");
{
    // Chemin entièrement découvert jusqu'ici. Il ne s'ouvre que sans consentement à la finalité 1.
    const LIST = "_ga,_fbp,sd_keep,x_suffix,mid_dle,euconsent-v2,usprivacy";
    const PRESENT = {"_ga": "1", "_fbp": "1", "sd_keep": "1", "x_suffix": "1", "mid_dle": "1",
                     "euconsent-v2": "1", "usprivacy": "1"};

    // Les deux cookies de consentement sont exemptés EN DUR : les effacer détruirait le choix
    // que la suppression est censée honorer.
    const base = run({sddan: SDDAN_LOCAL, data: {handleCookiesDeletion: true}, cookies: PRESENT});
    base.listener(purgeEvent(LIST), true);
    const d0 = deletedNames(base.calls);
    check("euconsent-v2 jamais effacé", d0.indexOf("euconsent-v2") === -1, JSON.stringify(d0));
    check("usprivacy jamais effacé", d0.indexOf("usprivacy") === -1);
    check("le reste est effacé", d0.indexOf("_ga") !== -1 && d0.indexOf("_fbp") !== -1);

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
        check(rule + " préserve " + c.kept, del.indexOf(c.kept) === -1, JSON.stringify(del));
        check(rule + " efface tout de même " + c.gone, del.indexOf(c.gone) !== -1, JSON.stringify(del));
    }

    // Le drapeau gouverne tout : sans lui, rien n'est effacé même avec une liste fournie.
    const off = run({sddan: SDDAN_LOCAL, cookies: PRESENT, data: {handleCookiesDeletion: false}});
    off.listener(purgeEvent(LIST), true);
    check("drapeau coupé : rien n'est effacé", deletedNames(off.calls).length === 0,
        JSON.stringify(deletedNames(off.calls)));

    // Et un consentement à la finalité 1 referme le chemin, quel que soit le drapeau.
    const consented = run({sddan: SDDAN_LOCAL, cookies: PRESENT, data: {handleCookiesDeletion: true}});
    consented.listener(Object.assign(purgeEvent(LIST), {
        purpose: {consents: {1: true}, legitimateInterests: {}}
    }), true);
    check("finalité 1 accordée : rien n'est effacé", deletedNames(consented.calls).length === 0,
        JSON.stringify(deletedNames(consented.calls)));
}

console.log("\n16. La section ___TESTS___ du .tpl reste structurellement saine");
{
    // Ce que ce contrôle vérifie, et rien de plus : la section existe, ses scénarios sont ancrés
    // en colonne 0, chacun porte un bloc `code:`, et deux ne partagent pas le même nom.
    //
    // Ce n'est PAS une validation YAML — ce dépôt n'a aucune dépendance et le README promet
    // « rien d'autre que node ». Ce qu'il attrape est la faute réelle : un scénario appendu à la
    // mauvaise indentation, ou un nom dupliqué, que seul l'éditeur GTM verrait sinon.
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
    check("la section porte des scénarios", names.length > 0, String(names.length));
    check("chacun porte un bloc code:", malformed === 0, malformed + " sans code");
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    check("aucun nom en double", dupes.length === 0, JSON.stringify(dupes));
    // L'éditeur REFUSE un nom de scénario commençant par « _ », et il est le seul à le dire :
    // rien dans le fichier ne le signale, donc la faute ne se voit qu'au moment de publier.
    // Deux noms sont partis ainsi, tirés du nom du cookie qu'ils exercent.
    const souligne = names.filter((n) => n.indexOf("_") === 0);
    check("aucun nom ne commence par un souligné", souligne.length === 0, JSON.stringify(souligne));
    // L'inventaire EXACT plutôt qu'un compte : un scénario qui disparaît est alors nommé, et le
    // contrôle ne peut pas être satisfait par un scénario qui en remplace un autre.
    const ATTENDUS = [
        "default settings sent",
        "default comes from __sdgcm when a consent cookie is present",
        "the stored signals are ignored without a consent cookie",
        "a malformed __sdgcm falls back instead of being read sideways",
        "an extra segment is still rejected",
        "a newer segment version is read for the signals it knows",
        "a cookie carrying no g segment falls back",
        "the GPC marker denies five signals and keeps two",
        "the template never writes the consent mode cookie"
    ];
    const manquants = ATTENDUS.filter((n) => names.indexOf(n) === -1);
    const inattendus = names.filter((n) => ATTENDUS.indexOf(n) === -1);
    check("l'inventaire des scénarios est exact",
        manquants.length === 0 && inattendus.length === 0,
        "manquants=" + JSON.stringify(manquants) + " inattendus=" + JSON.stringify(inattendus));
}

console.log("\n17. Les cookies que la CMP POSSÈDE survivent à sa propre suppression");
{
    // The deletion path opens when purpose 1 is NOT granted -- exactly when these cookies carry
    // the refusal that has to be remembered.
    // La liste est l'ensemble COMPLET des cookies que cette installation écrit. `__sdusnat`
    // porte les choix US détaillés, que les quatre caractères de `usprivacy` ne peuvent pas
    // contenir — format gelé par `__uspapi` et ses lecteurs tiers.
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
        check(OWNED[i] + " n'est jamais effacé", del.indexOf(OWNED[i]) === -1, JSON.stringify(del));
    }

    // Le discriminant, sans lequel tout ce bloc serait satisfait par un template qui n'efface
    // plus rien du tout.
    check("un cookie tiers de la même liste est bien effacé", del.indexOf("_ga") !== -1,
        JSON.stringify(del));

    // Ce cookie vient d'AILLEURS : le template le lit, il ne l'écrit pas. C'est ce qui rend
    // son exemption plus importante encore — l'effacer détruirait la donnée d'un autre
    // producteur, et le default du chargement suivant repartirait de rien.
    //
    // On assère le POT, pas un compte d'appels : c'est la survie du cookie qui est l'invariant.
    check("__sdgcm SURVIT intact à l'événement", r.cookies["__sdgcm"] === "1.1111111",
        JSON.stringify(r.cookies["__sdgcm"]));
    check("et le template n'a rien écrit du tout", r.calls.setCookies.every(
        (c) => c.options && c.options["max-age"] === -1), JSON.stringify(r.calls.setCookies));

    // Le pot doit refléter la suppression réelle, sinon l'assertion ci-dessus ne prouve rien.
    check("le pot reflète bien la suppression du tiers", r.cookies["_ga"] === undefined,
        JSON.stringify(r.cookies["_ga"]));

    // Une règle d'exemption de l'éditeur ne doit pas RÉDUIRE la liste en dur : elle s'y ajoute.
    const custom = run({
        sddan: SDDAN_LOCAL, cookies: PRESENT,
        data: {handleCookiesDeletion: true, cookieNames: [{value: "_ga", rule: "cookie_equals"}]}
    });
    custom.listener(purgeEvent(LIST), true);
    const del2 = deletedNames(custom.calls);
    check("une règle d'éditeur s'ajoute aux exemptions en dur",
        del2.length === 0 && custom.cookies["__sdgcm"] !== undefined, JSON.stringify(del2));
}

console.log("\n18. Le GPC agit sur le STATUT du Consent Mode, jamais sur le CHARGEMENT de la CMP");
{
    // Le marqueur change ce qu'on DÉCLARE à gtag. Il ne doit rien changer à l'injection des
    // scripts : couper le chargement priverait le visiteur de la bannière — donc du seul moyen
    // de revenir sur son opposition — pour un signal qui ne demande que de ne pas vendre.
    // Et le marqueur serait alors indélogeable, la bannière étant ce qui le retire.
    const ROW = {
        ad_storage: "granted", analytics_storage: "granted", personalization_storage: "granted",
        functionality_storage: "granted", security_storage: "granted",
        wait_for_update: 1000, region: "ALL"
    };
    const CMP = {settingsTable: [ROW], loadCmpScripts: true, partnerId: "1020", configId: "hmDnl"};

    const sans = run({sddan: SDDAN_LOCAL, data: CMP});
    const avec = run({sddan: SDDAN_LOCAL, data: CMP, cookies: {"__gpcactive": "1"}});

    // Témoin : sans lui, un harnais qui n'injecterait RIEN satisferait l'égalité ci-dessous.
    check("témoin — deux scripts injectés sans marqueur", sans.calls.injected.length === 2,
        JSON.stringify(sans.calls.injected));
    check("témoin — le stub puis le bundle",
        sans.calls.injected[0].indexOf("/stub") !== -1 && sans.calls.injected[1].indexOf("/cmp") !== -1,
        JSON.stringify(sans.calls.injected));

    check("le marqueur n'ôte aucun script", avec.calls.injected.length === 2,
        JSON.stringify(avec.calls.injected));
    check("et ce sont exactement les mêmes URL",
        JSON.stringify(avec.calls.injected) === JSON.stringify(sans.calls.injected),
        JSON.stringify(avec.calls.injected));

    // Le discriminant : sans lui, l'égalité ci-dessus serait aussi satisfaite par un GPC INERTE,
    // c'est-à-dire par un marqueur qui ne ferait rien du tout.
    check("alors que le statut, lui, change bien",
        sans.calls.defaults[0].ad_storage === "granted" && avec.calls.defaults[0].ad_storage === "denied",
        JSON.stringify([sans.calls.defaults[0].ad_storage, avec.calls.defaults[0].ad_storage]));
    check("et le chargement reste le même quand la CMP est coupée par la CONFIGURATION",
        run({sddan: SDDAN_LOCAL, data: {settingsTable: [ROW]}, cookies: {"__gpcactive": "1"}})
            .calls.injected.length === 0);
}

console.log("\n19. Le chemin US DÉCIDE, il ne déguise plus l'absence de RGPD");
{
    // `hasConsent` rend `!gdprApplies || <lookup>` : hors RGPD, tout est accordé. L'ancienne
    // forme forçait `tcData.gdprApplies = true` pour obtenir « pas de consentement ». Elle
    // mutait l'objet de la CMP, et surtout la règle « cinq refusés, DEUX conservés » n'était
    // pas tenue dans le cookie : `EVERY_STORAGE_SIGNAL_USED` met tout à 'denied', donc
    // functionality et security y tombaient dessus. Mesuré avant correctif : 2.g:1:0000000.
    const TOUT_ACCORDE = {
        ad_storage: "granted", analytics_storage: "granted", personalization_storage: "granted",
        functionality_storage: "granted", security_storage: "granted",
        wait_for_update: 1000, region: "ALL"
    };
    const US = {settingsTable: [TOUT_ACCORDE]};
    const USPAPI = {"__uspapi": function () { return undefined; }};
    // FABRIQUE : la règle US mutait son argument. Elle ne le mute plus, et c'est justement ce
    // qu'un des tests ci-dessous vérifie — donc l'objet doit être neuf à chaque cas.
    const evUs = () => ({gdprApplies: false, eventStatus: "useractioncomplete"});

    // Le marqueur apparaît APRÈS le default (le bundle l'écrit pendant la page vue) : le
    // default part accordé, et c'est l'update qui doit refuser. C'est le cas qui montre les
    // deux conservés, les autres étant absorbés par la déduplication.
    const objecte = run({sddan: SDDAN_LOCAL, data: US, globals: USPAPI});
    objecte.cookies["__gpcactive"] = "1";
    objecte.listener(evUs(), true);
    const u = objecte.calls.updates[0] || {};
    check("objection US — ad_storage refusé", u.ad_storage === "denied", JSON.stringify(u));
    check("objection US — analytics_storage refusé", u.analytics_storage === "denied");
    check("objection US — personalization_storage refusé", u.personalization_storage === "denied");
    check("objection US — ad_user_data refusé", u.ad_user_data === "denied");
    check("objection US — ad_personalization refusé", u.ad_personalization === "denied");
    check("objection US — functionality_storage CONSERVÉ", u.functionality_storage === "granted", JSON.stringify(u));
    check("objection US — security_storage CONSERVÉ", u.security_storage === "granted", JSON.stringify(u));
    check("et rien n'est écrit, même sous objection", objecte.calls.setCookies.length === 0,
        JSON.stringify(objecte.calls.setCookies));

    // `usprivacy` dit la même chose que le marqueur, et doit produire le même verdict.
    const parChaine = run({sddan: SDDAN_LOCAL, data: US, cookies: {"usprivacy": "1YYN"}, globals: USPAPI});
    parChaine.listener(evUs(), true);
    const uc = parChaine.calls.updates[0] || {};
    check("l'opt-out par usprivacy rend le même verdict",
        uc.ad_storage === "denied" && uc.functionality_storage === "granted", JSON.stringify(uc));

    // Une ligne TOUT REFUSÉ pour ces deux cas-ci : le default part alors refusé, donc un verdict
    // « accordé » se voit dans un update. Avec la ligne tout-accordé la déduplication l'absorbe,
    // et le test passerait sans rien exercer.
    const TOUT_REFUSE = {
        ad_storage: "denied", analytics_storage: "denied", personalization_storage: "denied",
        functionality_storage: "denied", security_storage: "denied",
        wait_for_update: 1000, region: "ALL"
    };
    const US_REFUSE = {settingsTable: [TOUT_REFUSE]};

    // Une chaîne SANS opposition est une décision, pas une absence : tout accordé.
    const pasObjecte = run({sddan: SDDAN_LOCAL, data: US_REFUSE, cookies: {"usprivacy": "1YNN"}, globals: USPAPI});
    pasObjecte.listener(evUs(), true);
    const up = pasObjecte.calls.updates[0] || {};
    check("pas d'opposition — tout accordé",
        up.ad_storage === "granted" && up.analytics_storage === "granted", JSON.stringify(up));

    // Une objection SUR une ligne tout-refusé : c'est le SEUL cas où router les deux conservés
    // par le verdict se voit. Avec la ligne tout-accordé, le repli `setting.X` rend 'granted' de
    // toute façon — donc l'assertion « les deux conservés » d'au-dessus passe, mais n'exerce
    // rien. Trou trouvé en re-mesurant la falsifiabilité : la mutation rendait 0 rouge.
    const objecteRefuse = run({sddan: SDDAN_LOCAL, data: US_REFUSE, cookies: {"usprivacy": "1YYN"}, globals: USPAPI});
    objecteRefuse.listener(evUs(), true);
    const ur = objecteRefuse.calls.updates[0] || {};
    check("objection sur ligne refusée — les deux conservés restent accordés",
        ur.functionality_storage === "granted" && ur.security_storage === "granted", JSON.stringify(ur));

    // TÉMOIN, et il est load-bearing : hors des États-Unis, « le RGPD ne s'applique pas » veut
    // toujours dire « tout est permis ». Sans lui, un verdict qui refuserait par défaut
    // passerait inaperçu et éteindrait la mesure du reste du monde.
    const horsUs = run({sddan: SDDAN_LOCAL, data: US_REFUSE});
    horsUs.listener(evUs(), true);
    const uh = horsUs.calls.updates[0] || {};
    check("témoin — hors US, tout reste accordé",
        uh.ad_storage === "granted" && uh.analytics_storage === "granted", JSON.stringify(uh));

    // L'objet appartient à la CMP. Le muter marchait, mais empruntait la machinerie d'une autre
    // régulation pour dire une chose simple — et un autre lecteur du même objet l'aurait subi.
    const ev = evUs();
    const sansMutation = run({sddan: SDDAN_LOCAL, data: US, cookies: {"__gpcactive": "1"}, globals: USPAPI});
    sansMutation.listener(ev, true);
    check("tcData n'est PAS muté", ev.gdprApplies === false, JSON.stringify(ev));

    // Forcer `gdprApplies` ouvrait aussi la suppression des cookies, `hasConsent` répondant
    // alors faux pour la finalité 1. Le comportement est conservé, mais énoncé.
    const purge = run({sddan: SDDAN_LOCAL, data: {settingsTable: [TOUT_ACCORDE], handleCookiesDeletion: true},
        cookies: {"__gpcactive": "1", "_ga": "x"}, globals: USPAPI});
    purge.listener(Object.assign(evUs(), {hostName: "example.com", cookieList: "_ga"}), true);
    check("une objection US ouvre toujours la suppression",
        deletedNames(purge.calls).indexOf("_ga") !== -1, JSON.stringify(deletedNames(purge.calls)));
}

// Plancher d'assertions : « zéro rouge » ne doit pas pouvoir vouloir dire « rien n'a tourné ».
// Une section supprimée par accident sortirait sinon en TOUT VERT. À relever avec le harnais.
const MIN_CHECKS = 137;
if (checksRun < MIN_CHECKS) {
    failures++;
    console.log("\n  FAIL seulement " + checksRun + " assertions exécutées, plancher = " + MIN_CHECKS);
}

console.log("\n" + checksRun + " assertions");
console.log(failures === 0 ? "TOUT VERT" : failures + " ECHEC(S)");
process.exit(failures === 0 ? 0 : 1);
