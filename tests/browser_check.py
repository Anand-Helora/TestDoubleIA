"""
Test de bout en bout dans Chromium headless (facultatif, outil de développement).
Ouvre index.html en file:// et joue des scénarios réels au clavier et à la souris.

Prérequis : pip install playwright && playwright install chromium
Lancement : python3 tests/browser_check.py [chemin_capture.png]
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / "index.html").as_uri()

results = []


def check(name, cond):
    results.append((name, bool(cond)))
    print(("OK   " if cond else "ÉCHEC") + " - " + name)


def state(page):
    return page.evaluate("() => JSON.parse(JSON.stringify(window.__snake.getState(), (k, v) => k === 'random' ? undefined : v))")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 600, "height": 700})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(URL)

        # 1. Chargement
        st = state(page)
        check("page chargée sans erreur JS", not errors)
        check("score initial affiché à 0", page.text_content("#score") == "0")
        check("écran de fin masqué au départ", page.is_hidden("#overlay"))
        check("serpent initial de 3 cases", len(st["snake"]) == 3)
        check("pomme hors du serpent", st["food"] not in st["snake"])

        # 2. Le jeu attend une touche puis démarre ; ZQSD fonctionne (z = haut)
        page.wait_for_timeout(300)
        check("le serpent ne bouge pas avant la première touche", state(page)["snake"] == st["snake"])
        head0 = st["snake"][0]
        page.keyboard.press("z")
        page.wait_for_timeout(180)
        head1 = state(page)["snake"][0]
        check("touche Z : le serpent monte", head1["x"] == head0["x"] and head1["y"] < head0["y"])

        # 3. Demi-tour refusé : il monte, on appuie sur bas
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(260)
        st = state(page)
        check("demi-tour (bas pendant montée) ignoré", st["status"] == "playing" and st["direction"] == "up")

        # 4. Manger une pomme : on place la pomme juste devant la tête
        page.evaluate("""() => { const s = window.__snake.getState();
            s.food = { x: s.snake[0].x, y: s.snake[0].y - 1 }; }""")
        page.wait_for_timeout(260)
        st = state(page)
        check("pomme mangée : score affiché à 1", page.text_content("#score") == "1")
        check("pomme mangée : serpent de 4 cases", len(st["snake"]) == 4)
        check("nouvelle pomme sur une case libre", st["food"] is not None and st["food"] not in st["snake"])

        # 5. Pause / reprise avec Espace
        page.keyboard.press(" ")
        frozen = state(page)["snake"]
        page.wait_for_timeout(400)
        check("Espace met en pause", state(page)["snake"] == frozen)
        page.keyboard.press(" ")
        page.wait_for_timeout(260)
        check("Espace reprend la partie", state(page)["snake"] != frozen or state(page)["status"] != "playing")

        # 6. Collision avec le mur du haut
        page.wait_for_selector("#overlay:not([hidden])", timeout=5000)
        check("collision mur : statut 'over'", state(page)["status"] == "over")
        check("« Partie terminée » affiché", page.text_content("#overlay-title") == "Partie terminée")
        check("bouton « Recommencer » visible", page.is_visible("#restart"))
        page.screenshot(path=sys.argv[1] if len(sys.argv) > 1 else "/tmp/snake_gameover.png")

        # 7. Recommencer à la souris
        page.click("#restart")
        st = state(page)
        check("recommencer : écran de fin masqué", page.is_hidden("#overlay"))
        check("recommencer : score remis à 0", page.text_content("#score") == "0")
        check("recommencer : serpent de 3 cases", len(st["snake"]) == 3 and st["status"] == "playing")

        # 8. Après redémarrage, un seul minuteur tourne (pas d'accélération)
        page.keyboard.press("ArrowDown")
        start = state(page)["snake"][0]["y"]
        page.wait_for_timeout(600)
        moved = state(page)["snake"][0]["y"] - start
        check(f"vitesse normale après redémarrage ({moved} cases en 600 ms, attendu ~5)", 3 <= moved <= 6)

        # 9. Collision avec le corps
        page.evaluate("""() => { const s = window.__snake.getState();
            s.snake = [{x:5,y:5},{x:6,y:5},{x:6,y:6},{x:5,y:6},{x:4,y:6}];
            s.direction = 'down'; s.queue = []; s.food = {x:0,y:0}; }""")
        page.wait_for_selector("#overlay:not([hidden])", timeout=2000)
        check("collision avec le corps : partie terminée", state(page)["status"] == "over")

        # 10. Recommencer avec Entrée
        page.keyboard.press("Enter")
        check("Entrée relance une partie", page.is_hidden("#overlay") and state(page)["score"] == 0)

        # 11. Les flèches n'entraînent pas le défilement de la page
        prevented = page.evaluate("""() => { const e = new KeyboardEvent('keydown',
            { key: 'ArrowUp', cancelable: true, bubbles: true });
            document.dispatchEvent(e); return e.defaultPrevented; }""")
        check("flèches : défilement de page empêché", prevented)

        check("aucune erreur console sur l'ensemble du parcours", not errors)
        browser.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} vérifications réussies")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
