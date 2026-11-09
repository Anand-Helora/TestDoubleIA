"""
Test de bout en bout dans un vrai navigateur (facultatif, outil de développement).
Ouvre index.html?test en file:// et joue des scénarios au clavier et à la souris.

Déterministe : Math.random est fixé avant le chargement de la page, le temps est
piloté par l'horloge simulée de Playwright (aucune attente en millisecondes
réelles) et chaque scénario fixe explicitement serpent, pomme et direction.

Prérequis : pip install playwright && playwright install chromium
Lancement : python3 tests/browser_check.py [--runs N] [--browser chromium|firefox|webkit] [--screenshot F.png]
"""
import argparse
import functools
import http.server
import pathlib
import sys
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / "index.html").as_uri() + "?test"
TICK = 120  # ms, doit correspondre à TICK_MS dans game.js

# Math.random() = 0 : chaque nouvelle pomme va sur la première case libre,
# (0,0) en pratique, loin des trajets utilisés par les scénarios (colonne x=10).
INIT_SCRIPT = "Math.random = function () { return 0; };"

# Horloge simulée : après install(), le temps continue de s'écouler au rythme
# réel tant que pause_at() n'est pas appelé. Sans pause, les ticks du jeu peuvent
# survenir entre deux étapes du test quand le navigateur est lent (échec
# intermittent observé sous Firefox en CI). On fige donc le temps après le
# chargement : seul run_for() le fait avancer.
CLOCK_START_S = 1_700_000_000  # l'API Python de Playwright attend des secondes


def install_frozen_clock(page):
    page.clock.install(time=CLOCK_START_S)


def freeze_clock(page):
    # Instant courant de la page + marge : à appeler après chaque chargement.
    page.clock.pause_at(page.evaluate("Date.now()") / 1000 + 1)


def clock_is_frozen(page):
    t1 = page.evaluate("Date.now()")
    time.sleep(0.3)
    return page.evaluate("Date.now()") == t1


class Run:
    def __init__(self, page):
        self.page = page
        self.results = []

    def check(self, name, cond):
        self.results.append((name, bool(cond)))
        print(("  OK    " if cond else "  ÉCHEC ") + "- " + name)

    def state(self):
        return self.page.evaluate(
            "() => JSON.parse(JSON.stringify(window.__snake.getState(),"
            " (k, v) => k === 'random' ? undefined : v))"
        )

    def setup(self, snake, food, direction):
        """Fixe un état connu sans changer le statut ni le minuteur."""
        self.page.evaluate(
            """([snake, food, dir]) => { const s = window.__snake.getState();
                s.snake = snake.map(([x, y]) => ({x, y}));
                s.food = food ? {x: food[0], y: food[1]} : null;
                s.direction = dir; s.queue = []; }""",
            [snake, food, direction],
        )

    def ticks(self, n):
        self.page.clock.run_for(n * TICK)


def scenario(run):
    page = run.page
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    install_frozen_clock(page)
    page.add_init_script(INIT_SCRIPT)
    page.goto(URL)
    freeze_clock(page)
    run.check("horloge simulée figée (seul run_for fait avancer le temps)", clock_is_frozen(page))

    # 1. Chargement
    st = run.state()
    run.check("page chargée sans erreur JS", not errors)
    run.check("score initial affiché à 0", page.text_content("#score") == "0")
    run.check("écran de fin masqué au départ", page.is_hidden("#overlay"))
    run.check("serpent initial de 3 cases au centre",
              st["snake"] == [{"x": 10, "y": 10}, {"x": 9, "y": 10}, {"x": 8, "y": 10}])
    run.check("pomme hors du serpent", st["food"] not in st["snake"])

    # 2. Attente de la première touche, puis Z (AZERTY) = haut
    run.ticks(5)
    run.check("le serpent ne bouge pas avant la première touche", run.state()["snake"] == st["snake"])
    run.setup([[10, 10], [9, 10], [8, 10]], [0, 0], "right")
    page.keyboard.press("z")
    run.ticks(1)
    run.check("touche Z : le serpent monte d'une case", run.state()["snake"][0] == {"x": 10, "y": 9})

    # 3. Demi-tour refusé
    page.keyboard.press("ArrowDown")
    run.ticks(1)
    st = run.state()
    run.check("demi-tour (bas pendant la montée) ignoré",
              st["status"] == "playing" and st["direction"] == "up" and st["snake"][0] == {"x": 10, "y": 8})

    # 4. Manger une pomme : état fixé, une seule pomme possible sur le trajet
    run.setup([[10, 8], [10, 9], [10, 10]], [10, 7], "up")
    before = run.state()
    run.ticks(1)
    st = run.state()
    run.check("record affiché mis à jour avec le score", page.text_content("#best") == str(st["score"]))
    run.check("pomme mangée : score +1 (affiché)",
              st["score"] == before["score"] + 1 and page.text_content("#score") == str(st["score"]))
    run.check("pomme mangée : longueur +1", len(st["snake"]) == len(before["snake"]) + 1)
    run.check("nouvelle pomme sur une case libre", st["food"] is not None and st["food"] not in st["snake"])
    run.ticks(2)
    st2 = run.state()
    run.check("pas d'autre pomme mangée ensuite", st2["score"] == st["score"] and len(st2["snake"]) == len(st["snake"]))

    # 5. Pause, puis maintien d'Espace (répétitions clavier natives Playwright)
    run.setup([[10, 8], [10, 9], [10, 10], [10, 11]], [0, 0], "up")
    page.keyboard.down(" ")            # premier appui : pause
    frozen = run.state()["snake"]
    for _ in range(20):                # touche maintenue : keydown avec repeat=true
        page.keyboard.down(" ")
        run.ticks(1)
    run.check("Espace maintenu : reste en pause, aucun déplacement", run.state()["snake"] == frozen)
    run.check("Espace maintenu : message de pause conservé", "Pause" in page.text_content("#message"))
    page.keyboard.up(" ")
    run.ticks(3)
    run.check("relâcher Espace : toujours en pause", run.state()["snake"] == frozen)
    page.keyboard.press(" ")           # nouvel appui distinct : reprise
    run.ticks(1)
    run.check("nouvel appui sur Espace : reprise d'une case", run.state()["snake"][0] == {"x": 10, "y": 7})

    # 6. Collision avec le mur du haut
    run.setup([[10, 1], [10, 2], [10, 3]], [0, 0], "up")
    run.ticks(1)
    run.check("encore en jeu en y=0", run.state()["status"] == "playing")
    run.ticks(1)
    run.check("collision mur : statut 'over'", run.state()["status"] == "over")
    run.check("« Partie terminée » affiché",
              page.is_visible("#overlay") and page.text_content("#overlay-title") == "Partie terminée")
    run.check("bouton « Recommencer » visible et focalisé",
              page.is_visible("#restart") and page.evaluate("document.activeElement.id") == "restart")
    if run.screenshot:
        page.screenshot(path=run.screenshot)

    # 7. Recommencer avec Entrée sur le bouton focalisé (activation native)
    page.keyboard.press("Enter")
    st = run.state()
    run.check("Entrée sur le bouton : nouvelle partie", page.is_hidden("#overlay") and st["status"] == "playing")
    run.check("recommencer : score 0 et serpent de 3 cases",
              page.text_content("#score") == "0" and len(st["snake"]) == 3)

    # 8. Plusieurs redémarrages à la souris : un seul minuteur (vitesse constante)
    for _ in range(10):
        run.setup([[10, 1], [10, 2], [10, 3]], [0, 0], "up")
        page.keyboard.press("ArrowUp")
        run.ticks(2)
        page.click("#restart")
    page.keyboard.press("ArrowDown")
    y0 = run.state()["snake"][0]["y"]
    run.ticks(5)
    moved = run.state()["snake"][0]["y"] - y0
    run.check(f"après 10 redémarrages : 5 cases en 5 pas (mesuré : {moved})", moved == 5)

    # 9. Collision avec le corps
    run.setup([[5, 5], [6, 5], [6, 6], [5, 6], [4, 6]], [0, 0], "down")
    run.ticks(1)
    run.check("collision avec le corps : partie terminée", run.state()["status"] == "over")

    # 10. La tête peut prendre la case libérée par la queue
    page.click("#restart")
    page.keyboard.press("ArrowUp")
    run.setup([[5, 5], [6, 5], [6, 6], [5, 6]], [0, 0], "down")
    run.ticks(1)
    st = run.state()
    run.check("case libérée par la queue : la partie continue",
              st["status"] == "playing" and st["snake"][0] == {"x": 5, "y": 6})

    # 11. Victoire côté interface : dernière case libre mangée
    page.evaluate("""() => { const s = window.__snake.getState();
        const snake = [];
        for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) snake.push({x, y});
        // tout le plateau sauf (0,0) ; la tête en (1,0) va vers la gauche
        snake.splice(0, 1);
        s.snake = snake; s.food = {x: 0, y: 0}; s.direction = 'left'; s.queue = []; }""")
    run.ticks(1)
    run.check("grille remplie : « Victoire ! » affiché",
              run.state()["status"] == "won" and page.text_content("#overlay-title") == "Victoire !")

    # 12. Entrée hors du bouton relance aussi
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("Enter")
    run.check("Entrée (hors bouton) relance une partie", page.is_hidden("#overlay") and run.state()["score"] == 0)

    # 13. Les flèches ne font pas défiler la page
    prevented = page.evaluate("""() => { const e = new KeyboardEvent('keydown',
        { key: 'ArrowUp', cancelable: true, bubbles: true });
        document.dispatchEvent(e); return e.defaultPrevented; }""")
    run.check("flèches : défilement de page empêché", prevented)

    run.check("aucune erreur console sur l'ensemble du parcours", not errors)


BEST_KEY = "snake.bestScore"

STORAGE_BLOCKED_SCRIPTS = {
    # Stockage présent mais toutes les opérations échouent (quota, politique…)
    "méthodes Storage qui lèvent": """
        Storage.prototype.getItem = function () { throw new DOMException('bloqué', 'SecurityError'); };
        Storage.prototype.setItem = function () { throw new DOMException('plein', 'QuotaExceededError'); };
    """,
    # Le simple accès à window.localStorage lève (cookies bloqués, iframe sandboxée)
    "accès à localStorage qui lève": """
        try {
          Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get: function () { throw new DOMException('bloqué', 'SecurityError'); }
          });
        } catch (e) {}
    """,
}


def start_server():
    """Serveur HTTP local : origine stable pour tester la persistance localStorage."""
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/index.html?test"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def open_page(browser, url, extra_script=None):
    context = browser.new_context()
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    install_frozen_clock(page)
    page.add_init_script(INIT_SCRIPT)
    if extra_script:
        page.add_init_script(extra_script)
    page.goto(url)
    freeze_clock(page)
    return context, page, errors


def eat(run, n):
    """Démarre si besoin et fait manger n pommes en montant depuis le bas du plateau."""
    run.page.keyboard.press("ArrowUp")
    run.setup([[10, 15], [10, 16], [10, 17]], [0, 0], "up")
    for _ in range(n):
        head = run.state()["snake"][0]
        run.page.evaluate("([x, y]) => { window.__snake.getState().food = {x, y}; }", [head["x"], head["y"] - 1])
        run.ticks(1)


def storage_scenarios(browser, url):
    """Meilleur score : persistance, valeurs corrompues, stockage bloqué (Issue #3)."""
    failed = 0

    # Persistance entre deux chargements de la page
    context, page, errors = open_page(browser, url)
    run = Run(page)
    run.check("record initial à 0", page.text_content("#best") == "0")
    eat(run, 3)
    run.check("record 3 affiché immédiatement en cours de partie",
              page.text_content("#best") == "3" and run.state()["status"] == "playing")
    run.check("record enregistré dans localStorage",
              page.evaluate(f"localStorage.getItem('{BEST_KEY}')") == "3")
    page.reload()
    freeze_clock(page)
    run.check("horloge figée après rechargement", clock_is_frozen(page))
    run.check("record relu après rechargement", page.text_content("#best") == "3")
    eat(run, 1)
    run.check("score plus faible : record inchangé", page.text_content("#best") == "3")

    # Valeurs corrompues ou négatives
    for raw in ["-5", "abc", "2.5", "Infinity"]:
        page.evaluate(f"localStorage.setItem('{BEST_KEY}', {raw!r})")
        page.reload()
        freeze_clock(page)
        ok = page.text_content("#best") == "0"
        eat(run, 1)
        ok = ok and page.evaluate(f"localStorage.getItem('{BEST_KEY}')") == "1"
        run.check(f"valeur stockée {raw!r} refusée (record 0), puis remplacée", ok)
    run.check("aucune erreur JS (persistance)", not errors)
    failed += sum(not ok for _, ok in run.results)
    context.close()

    # Stockage indisponible : le jeu reste jouable
    for label, script in STORAGE_BLOCKED_SCRIPTS.items():
        context, page, errors = open_page(browser, url, script)
        run = Run(page)
        blocked = page.evaluate("""() => { try { localStorage.getItem('x'); return false; }
                                           catch (e) { return true; } }""")
        run.check(f"{label} : blocage simulé effectif", blocked)
        run.check(f"{label} : page chargée, record 0", page.text_content("#best") == "0")
        eat(run, 2)
        run.check(f"{label} : score et record mis à jour en mémoire",
                  page.text_content("#score") == "2" and page.text_content("#best") == "2")
        run.setup([[10, 1], [10, 2], [10, 3]], [0, 0], "up")
        run.ticks(2)
        run.check(f"{label} : fin de partie et « Nouveau record ! »",
                  run.state()["status"] == "over" and "Nouveau record" in page.text_content("#message"))
        page.click("#restart")
        run.check(f"{label} : redémarrage, record conservé",
                  page.text_content("#score") == "0" and page.text_content("#best") == "2")
        run.check(f"{label} : aucune erreur JS", not errors)
        failed += sum(not ok for _, ok in run.results)
        context.close()
    return failed


def pause_button_scenarios(browser):
    """Bouton Pause / Reprendre (Issue #7) : souris, tactile, clavier, accessibilité, mobile."""
    context = browser.new_context(viewport={"width": 375, "height": 740}, has_touch=True)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    install_frozen_clock(page)
    page.add_init_script(INIT_SCRIPT)
    page.goto(URL)
    freeze_clock(page)
    run = Run(page)
    paused = lambda: page.evaluate("window.__snake.isPaused()")
    label = lambda: page.text_content("#pause")

    # Accessibilité de base et état initial
    btn = page.get_by_role("button", name="Pause")
    run.check("bouton accessible (rôle button, nom « Pause »)", btn.count() == 1)
    run.check("désactivé avant le démarrage", page.is_disabled("#pause"))
    run.check("indisponibilité expliquée (aria-describedby)",
              page.evaluate("document.getElementById(document.getElementById('pause').getAttribute('aria-describedby')).textContent")
              .startswith("Disponible"))
    box, scores, board = (page.locator(sel).bounding_box() for sel in ("#pause", ".scores", "#board"))
    run.check("mobile 375 px : bouton visible, sous le plateau, sans masquer les scores",
              box["y"] >= board["y"] + board["height"] and box["y"] + box["height"] <= 740
              and box["y"] > scores["y"] + scores["height"] and box["height"] >= 44)

    # Démarrage puis pause à la souris
    run.setup([[10, 15], [10, 16], [10, 17]], [0, 0], "right")
    page.keyboard.press("ArrowUp")
    run.ticks(1)
    run.check("activé une fois la partie commencée", page.is_enabled("#pause") and label() == "Pause")
    page.click("#pause")
    frozen = run.state()["snake"]
    run.ticks(5)
    run.check("clic sur Pause : déplacement figé, libellé « Reprendre »",
              paused() and run.state()["snake"] == frozen and label() == "Reprendre")
    run.check("nom accessible mis à jour", page.get_by_role("button", name="Reprendre").count() == 1)
    page.click("#pause")
    run.ticks(3)
    run.check("clic sur Reprendre : 3 cases en 3 pas (un seul minuteur)",
              not paused() and run.state()["snake"][0] == {"x": 10, "y": 11} and label() == "Pause")

    # Tactile
    page.tap("#pause")
    run.check("toucher : pause", paused() and label() == "Reprendre")
    page.tap("#pause")
    run.check("toucher : reprise", not paused() and label() == "Pause")

    # Espace avec le focus sur le bouton : activation native, une seule bascule
    page.focus("#pause")
    page.keyboard.press(" ")
    run.check("Espace sur le bouton focalisé : une seule bascule (pause)", paused() and label() == "Reprendre")
    page.keyboard.press(" ")
    run.check("Espace sur le bouton focalisé : une seule bascule (reprise)", not paused())
    page.keyboard.press("Enter")
    run.check("Entrée sur le bouton focalisé : une seule bascule", paused())
    page.keyboard.press("Enter")

    # Espace hors du bouton : synchronisé avec le bouton
    page.focus("#board")
    page.keyboard.press(" ")
    run.check("Espace sur le plateau : pause et bouton synchronisé", paused() and label() == "Reprendre")
    page.click("#pause")
    run.check("reprise au bouton après pause au clavier", not paused() and label() == "Pause")
    page.focus("#board")
    y0 = run.state()["snake"][0]["y"]
    run.ticks(2)
    run.check("après toutes ces bascules : 1 case par pas", y0 - run.state()["snake"][0]["y"] == 2)

    # Fin de partie, redémarrage
    run.setup([[10, 1], [10, 2], [10, 3]], [0, 0], "up")
    run.ticks(2)
    run.check("fin de partie : bouton désactivé, libellé « Pause »",
              run.state()["status"] == "over" and page.is_disabled("#pause") and label() == "Pause")
    page.click("#restart")
    run.check("redémarrage : bouton désactivé jusqu'à la première touche", page.is_disabled("#pause"))
    page.keyboard.press("ArrowUp")  # le serpent part vers la droite : « gauche » serait un demi-tour
    y = run.state()["snake"][0]
    run.ticks(3)
    run.check("nouvelle partie : bouton actif et vitesse normale",
              page.is_enabled("#pause") and run.state()["snake"][0]["y"] == y["y"] - 3)
    run.check("score et record toujours affichés", page.is_visible("#score") and page.is_visible("#best"))
    run.check("aucune erreur JS (bouton Pause)", not errors)
    failed = sum(not ok for _, ok in run.results)
    context.close()
    return failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--browser", default="chromium", choices=["chromium", "firefox", "webkit"])
    ap.add_argument("--screenshot", default=None)
    args = ap.parse_args()

    total_failed = 0
    with sync_playwright() as p:
        browser = getattr(p, args.browser).launch()
        for i in range(args.runs):
            print(f"Exécution {i + 1}/{args.runs} ({args.browser})")
            page = browser.new_page(viewport={"width": 600, "height": 700})
            run = Run(page)
            run.screenshot = args.screenshot if i == 0 else None
            scenario(run)
            failed = [n for n, ok in run.results if not ok]
            print(f"  → {len(run.results) - len(failed)}/{len(run.results)} vérifications réussies")
            total_failed += len(failed)
            page.close()

        print(f"Bouton Pause / Reprendre ({args.browser})")
        total_failed += pause_button_scenarios(browser)

        server, http_url = start_server()
        print(f"Meilleur score et stockage ({args.browser}, {http_url})")
        total_failed += storage_scenarios(browser, http_url)
        server.shutdown()

        # Hors mode test, aucun crochet global n'est exposé.
        page = browser.new_page()
        page.goto((ROOT / "index.html").as_uri())
        exposed = page.evaluate("typeof window.__snake")
        print(("  OK    " if exposed == "undefined" else "  ÉCHEC ") + "- window.__snake absent sans ?test")
        total_failed += exposed != "undefined"
        browser.close()

    print("\nRÉSULTAT :", "tout est réussi" if total_failed == 0 else f"{total_failed} échec(s)")
    sys.exit(1 if total_failed else 0)


if __name__ == "__main__":
    main()
