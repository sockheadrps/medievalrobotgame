# 🛸 Project: Iron Anachronism
**Genre:** Top-Down Automation / Survival RPG  
**Engine:** Phaser.js (Recommended)
**Setting:** Sci-Fi Engineer crash-landed in a High-Fantasy/Medieval world.

---

## 1. Core Narrative & Premise
You are a high-tech engineer from a post-scarcity future. Following a catastrophic ship failure, you crash-land on a medieval-era Earth. Your only remaining asset is the **Core Fabrication Unit (The Mother Machine)**. 

To survive and rebuild, you must use the Mother Machine to automate resource extraction. However, the local kingdoms view your "metal demons" and "thunder-sticks" as a threat to their way of life.

---

## 2. Key Gameplay Pillars

### 🏗️ The Mother Machine (The Hub)
* **Progression:** The Machine is your mobile base and crafting station.
* **Tier System:** * *Tier 1 (Scrap):* Uses Wood and Stone to build basic mechanical drones.
    * *Tier 2 (Industrial):* Uses Iron and Coal to unlock electricity and basic turrets.
    * *Tier 3 (Quantum):* Uses Rare Gems and Gold to unlock teleportation and plasma shields.

### 🤖 The Bot Swarm (Automation)
* **Directives:** You don't perform manual labor. You set "Directives" for your robots.
* **Specializations:**
    * *Scouts:* Map out the fog of war.
    * *Harvesters:* Automatically pathfind to the nearest resource and bring it back.
    * *Sentries:* Defend a specific radius around the Machine.

### ⚔️ Conflict & Land Claims
* **Encroachment:** Placing "Claim Pylons" expands your buildable area but enrages the local NPCs.
* **Heat System:** High activity (noise/smoke) attracts larger medieval raiding parties.
* **Combat:** Defensive tower-defense style play mixed with direct player intervention (Future gadgets vs. Swords/Magic).

---

## 3. Initial Technical Roadmap

### Phase 1: The "Minimal Viable Loop" (Week 1-2)
* [ ] **Engine Setup:** Initialize Phaser 3 with a basic Tilemap.
* [ ] **Player Controller:** Implement top-down WASD movement and a simple "Interact" key.
* [ ] **The Machine:** Create a static entity that opens a "Crafting Menu" when the player is near.
* [ ] **Manual Gathering:** Allow the player to click a tree to add "Wood" to their inventory.

### Phase 2: The First Robot (Week 3-4)
* [ ] **Automation Logic:** Create a `Robot` class with a simple State Machine:
    * `IDLE` -> `SEARCHING` -> `GATHERING` -> `DELIVERING`
* [ ] **Storage:** Create a "Crate" entity where robots drop off items.

### Phase 3: The Threat (Week 5-6)
* [ ] **Enemy AI:** Simple pathfinding for "Peasants" and "Knights" to target the Mother Machine.
* [ ] **Turret System:** A basic building that fires at any entity in the `enemy` group.

---

## 4. Setup Guide: Starting the Project

To start this in a browser, you need a basic `index.html` file that loads the Phaser library.

### Step 1: Create `index.html`
```html
<!DOCTYPE html>
<html>
<head>
    <script src="[https://cdn.jsdelivr.net/npm/phaser@3.60.0/dist/phaser-arcade-physics.min.js](https://cdn.jsdelivr.net/npm/phaser@3.60.0/dist/phaser-arcade-physics.min.js)"></script>
</head>
<body>
    <script src="game.js"></script>
</body>
</html>


4. Areas for Potential Improvement
While the system is very solid, consider these minor tweaks:

The "Deposit Extra" Ambiguity: In smelt.txt, your example shows a goal deposit_extra, but that goal isn't formally defined in the available smelting goals list—it's primarily in gather.txt and store.txt. Ensure all specialists recognize the deposit_extra goal if you want them to use it.

State Management: Currently, if a player says "Make arrows," the specialist returns a full loop of 6 goals. If the world state changes (e.g., the anvil is destroyed), the NPC will need a new "parse" to react. You might consider having the NPC call the /parse_command endpoint itself periodically to re-evaluate its goals based on the updated world_context.

Router Fallback: If the router returns a category that isn't in VALID_CATEGORIES, you fall back to fallback.txt [main.py Stage 1]. You may want to log these "unknown" categories to see if you need to create a new specialist for a common player request you hadn't considered.

Here are suggestions for further improving the logic and implementation without requiring a total rework:

1. Robustness & Error Handling
Validation of Outputs: The _extract_json function handles malformed strings, but it doesn't verify if the JSON contains valid task names or required keys (like targetQty or item). Implementing a Pydantic-based validation step after extraction would ensure the NPC never receives an unexecutable command.

Router Confidence: If the Router is unsure, it might pick a category at random. You could adjust the _route function to check the logprobs (if available via Ollama) or instruct the router to output "fallback" if the instruction is ambiguous.

Context Token Management: As world_context and npc_context grow, they may eventually bloat the prompt. Consider a "Context Filter" that only sends objects within a certain radius of the NPC to the specialist.

2. Prompting Enhancements
Standardizing "Deposit Extra": There is currently some inconsistency across specialists regarding the deposit_extra goal. It is defined in gather.txt and used in an example in smelt.txt, but it is missing from the "Available tasks" list in smelt.txt and craft.txt. Standardizing this goal across all files will prevent "hallucinated" tasks that the game engine might not recognize.

Few-Shot Consistency: In combat.txt, the rules mention "Default targetQty is 10", but some examples use 50 or 20. Ensuring the examples strictly mirror the rules helps the model learn the "defaulting" behavior more accurately.

Handling Negations: Smaller models often struggle with "Don't do X." The follow.txt prompt handles "stop" well by mapping it to idle. Expanding this "stop" logic to other specialists (e.g., "Stop smelting") would make the NPC feel more responsive.

3. Structural Improvements (The "Brain" Loop)
Goal State vs. Task List: Currently, the system returns a static list of tasks. If the NPC is told to "make 20 arrows", it gets a long list of goals. If the NPC runs out of iron midway, it will fail.

Suggested Change: Instead of the LLM generating the full sequence, have the LLM identify the desired state. The game engine then uses a simple state machine or Behavior Tree to execute the specific steps (gather -> smith -> craft) based on that state.

Interrupt Logic: Add an "interrupt" check. If the NPC is in a loop (like crank_flywheel) and the player gives a new command, the system should explicitly clear the old loop. Your current FastAPI implementation replaces the command list on every call, which is a good start for this.


Batched Context: If you have many NPCs, sending individual HTTP requests for each one is slow. You could modify the parse_command endpoint to accept a list of NPC requests and process them in a batch, which is more efficient for GPU utilization.

Overall, your logic of using specialized text files for different domains is the correct way to build complex NPC behavior. It allows for easy "hot-fixes" to behavior without touching the core Python code.