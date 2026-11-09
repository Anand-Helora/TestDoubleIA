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
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / "index.html").as_uri() + "?test"
TICK = 120  # ms, doit correspondre à TICK_MS dans game.js

# Math.random() = 0 : chaque nouvelle pomme va sur la première case libre,
# (0,0) en pratique, loin des trajets utilisés par les scénarios (colonne x=10).
INIT_SCRIPT = "Math.random = function () { return 0; };"


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
    page.clock.install()
    page.add_init_script(INIT_SCRIPT)
    page.goto(URL)

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
