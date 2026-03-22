"""InputHandler — server-side message router for all client actions.

Extracted from PlayerManager.handle_input. Dispatches each msg_type to
the appropriate service on game_state.
"""

import logging
import math
import time

from core.constants import PLAYER_SPEED, PLAYER_RUN_SPEED
from services.database import get_setting as _db_get_setting

logger = logging.getLogger(__name__)


class InputHandler:
    def __init__(self, game_state):
        self.gs = game_state

    def handle_input(self, pid: str, data: dict):
        """
        Full server-side message router — dispatches all client actions to the
        appropriate service (combat, resources, building, npc_manager, portals,
        player).
        """
        gs = self.gs
        p = gs.players.get(pid)
        if not p:
            return

        msg_type = data.get("type")

        # Block most actions while dead or knocked out.
        if (p.get("dead") or p.get("knocked_out")) and msg_type not in ("sync_npcs", "admin"):
            return

        # Ki silence gate — block ki actions while silenced
        _KI_MSG_TYPES = {
            "ki_blast_player", "ki_blast_npc", "ki_blast_dummy",
            "ki_blast_ground_item", "ki_blast_ki_target", "ki_blast_miss",
            "absorb_npc", "npc_absorb_npc",
            "npc_ki_blast_player", "npc_ki_blast_npc", "npc_ki_blast_ki_target",
            "activate_barrier",
        }
        if msg_type in _KI_MSG_TYPES and p.get("ki_silenced_until", 0) > time.time():
            return  # silenced — no ki actions allowed

        if msg_type == "stop":
            p["vx"] = 0
            p["vy"] = 0
            p["anim"] = "idle"

        elif msg_type == "move":
            dx = data.get("dx", 0)
            dy = data.get("dy", 0)
            running = data.get("running", False)
            speed = PLAYER_RUN_SPEED if running else PLAYER_SPEED
            if p.get("flying"):
                speed *= 1.5
            try:
                _sm = float(_db_get_setting("admin_speed_multiplier", "1") or "1")
                if _sm > 0:
                    speed *= _sm
            except (ValueError, TypeError):
                pass

            # Normalize diagonal
            if dx != 0 and dy != 0:
                dx /= math.sqrt(2)
                dy /= math.sqrt(2)

            p["vx"] = dx * speed
            p["vy"] = dy * speed

            # Update facing
            if dx < 0:
                p["facing"] = "left"
            elif dx > 0:
                p["facing"] = "right"
            elif dy < 0:
                p["facing"] = "up"
            elif dy > 0:
                p["facing"] = "down"

            moving = dx != 0 or dy != 0
            if moving:
                p["anim"] = "run" if running else "walk"
            else:
                p["anim"] = "idle"

        elif msg_type == "chop":
            gs.resources._try_chop(pid, data.get("tree_id"))

        elif msg_type == "mine_rock":
            gs.resources._try_mine_rock(pid, data.get("rock_id"))

        elif msg_type == "mine_tile":
            col = data.get("col")
            row = data.get("row")
            if col is not None and row is not None:
                gs.resources._try_mine_tile(pid, int(col), int(row))

        elif msg_type == "request_mine_tiles":
            tiles = gs.resources.get_mine_tiles_for_player(pid)
            if tiles is not None:
                gs.fx_events.append({
                    "type": "mine_update", "pid": pid,
                    "tiles": tiles,
                })

        elif msg_type == "attack_dummy":
            gs.combat._try_attack_dummy(pid, data.get("dummy_id"))

        elif msg_type == "build_dummy":
            gs.building._try_build_dummy(pid, data.get("logs", 10),
                                         col=data.get("col"), row=data.get("row"))

        elif msg_type == "delete_dummy":
            dummy_id = data.get("dummy_id")
            if dummy_id and dummy_id in gs.dummies:
                gs.dummies[dummy_id]["dead"] = True

        elif msg_type == "build_anvil":
            gs.building._try_build_anvil(pid)

        elif msg_type == "delete_anvil":
            anvil_id = data.get("anvil_id")
            if anvil_id and anvil_id in gs.anvils:
                gs.anvils[anvil_id]["dead"] = True

        elif msg_type == "place_building":
            gs.building._place_building(pid, data)

        elif msg_type == "attack_fence":
            gs.combat._try_attack_fence(pid, data.get("building_id"))

        elif msg_type == "remove_building":
            bid = data.get("building_id")
            if bid and bid in gs.buildings:
                if gs.buildings[bid].get("kind") == "etrainer":
                    gs.dummies.pop(bid, None)
                del gs.buildings[bid]

        elif msg_type == "update_building_stored":
            bid = data.get("building_id")
            stored = data.get("stored")
            if bid and bid in gs.buildings and isinstance(stored, dict):
                gs.buildings[bid]["stored"] = stored

        elif msg_type == "update_building_out_dir":
            bid = data.get("building_id")
            out_dir = data.get("out_direction", "")
            if bid and bid in gs.buildings:
                gs.buildings[bid]["out_direction"] = out_dir

        elif msg_type == "update_building_label":
            bid = data.get("building_id")
            label = data.get("label", "")
            if bid and bid in gs.buildings:
                gs.buildings[bid]["label"] = str(label)[:32]

        elif msg_type == "deduct_resource":
            resource = data.get("resource", "")
            amt = max(0, int(data.get("amount", 1)))
            if resource == "logs":
                p["logs"] = max(0, p.get("logs", 0) - amt)
            elif resource in ("stones", "crystals", "copper", "meat", "feathers", "vegetables", "seeds"):
                p[resource] = max(0, p.get(resource, 0) - amt)
            else:
                inv = p.setdefault("inventory", {})
                inv[resource] = max(0, inv.get(resource, 0) - amt)
                if inv[resource] <= 0:
                    inv.pop(resource, None)

        elif msg_type == "grant_resource":
            resource = data.get("resource", "")
            amt = max(0, int(data.get("amount", 1)))
            if resource == "logs":
                p["logs"] = p.get("logs", 0) + amt
            elif resource in ("stones", "crystals", "copper", "meat", "feathers", "vegetables", "seeds"):
                p[resource] = p.get(resource, 0) + amt
            else:
                inv = p.setdefault("inventory", {})
                inv[resource] = inv.get(resource, 0) + amt

        elif msg_type == "minecart_portal":
            gs.building._handle_minecart_portal(pid, data)

        elif msg_type == "refine_rock":
            gs.resources._try_refine_rock(pid, data.get("anvil_id"), data.get("npc_id"))

        elif msg_type == "punch":
            p["punching"] = True
            p["punch_until"] = time.time() + 0.3

        elif msg_type == "npc_chop":
            owner_id = data.get("owner_id", pid)
            gs.resources._npc_chop(data.get("tree_id"), owner_id, data.get("npc_id"))

        elif msg_type == "npc_pickup_stone":
            gs.resources._npc_pickup_stone(pid, data.get("npc_id"), data.get("item_id"))
        elif msg_type == "npc_mine_rock":
            gs.resources._npc_mine_rock(pid, data.get("npc_id"), data.get("rock_id"))
        elif msg_type == "npc_pickup_stone_tile":
            gs.resources._npc_pickup_stone_tile(pid, data.get("npc_id"), data.get("x"), data.get("y"))

        elif msg_type == "npc_refine_rock":
            gs.resources._npc_refine_rock(pid, data.get("npc_id"), data.get("anvil_id"))

        elif msg_type == "npc_give_materials":
            gs.resources._npc_give_materials(pid, data.get("npc_id"))

        elif msg_type == "npc_interact_world_object":
            gs.resources._npc_interact_world_object(pid, data.get("npc_id"), data.get("wo_id"))

        elif msg_type == "npc_deposit_to_crate":
            gs.resources._npc_deposit_to_crate(
                pid, data.get("npc_id"), data.get("building_id"),
                data.get("resource"), data.get("amount", 1))

        elif msg_type == "admin":
            gs.player_manager._handle_admin(p, data)

        elif msg_type == "npc_attack_dummy":
            npc_id = data.get("npc_id", "npc")
            gs.combat._npc_attack_dummy(pid, npc_id, data.get("dummy_id"), data.get("str", 1))

        elif msg_type == "attack_player":
            gs.combat._try_attack_player(pid, data.get("target_id"))

        elif msg_type == "attack_npc":
            gs.combat._try_attack_npc(pid, data.get("owner_id"), data.get("npc_id"))

        elif msg_type == "ki_blast_miss":
            cost, _dmg = gs.combat._calc_blast(p.get("blastLevel", 0))
            cost, _dmg = gs.combat._apply_blast_mode(cost, _dmg, data.get("blast_mode", ""))
            if gs.combat._try_ki_spend(p, cost):
                gs.combat._queue_ki_blast_fx(p, owner_pid=pid)

        elif msg_type == "ki_blast_player":
            gs.combat._ki_blast_player(pid, data.get("target_id"), data.get("blast_mode", ""))

        elif msg_type == "ki_blast_npc":
            gs.combat._ki_blast_npc(pid, data.get("owner_id"), data.get("npc_id"), data.get("blast_mode", ""))
        elif msg_type == "ki_blast_dummy":
            gs.combat._ki_blast_dummy(pid, data.get("dummy_id"), data.get("blast_mode", ""))

        elif msg_type == "ki_blast_ground_item":
            gs.combat._ki_blast_ground_item(pid, data.get("item_id"), data.get("blast_mode", ""))

        elif msg_type == "absorb_npc":
            gs.combat._start_player_absorb(pid, data.get("owner_id"), data.get("npc_id"))

        elif msg_type == "npc_ki_blast_player":
            gs.combat._npc_ki_blast_player(pid, data.get("npc_id"), data.get("target_id"))

        elif msg_type == "npc_ki_blast_npc":
            gs.combat._npc_ki_blast_npc(pid, data.get("npc_id"), data.get("owner_id"), data.get("target_npc_id"))

        elif msg_type == "npc_ki_blast_ki_target":
            gs.combat._npc_ki_blast_ki_target(pid, data.get("npc_id"), data.get("target_id"))

        elif msg_type == "npc_absorb_npc":
            gs.combat._start_npc_absorb(pid, data.get("npc_id"), data.get("target_owner"), data.get("target_npc_id"))

        elif msg_type == "npc_attack_player":
            npc_id = data.get("npc_id", "npc")
            gs.combat._npc_attack_player(pid, data.get("target_id"), data.get("str", 1), npc_id)

        elif msg_type == "npc_attack_npc":
            npc_id = data.get("npc_id", "npc")
            gs.combat._npc_attack_npc(pid, npc_id, data.get("target_owner"), data.get("target_npc_id"), data.get("str", 1))

        elif msg_type == "npc_steal_logs":
            npc_id = data.get("npc_id", "npc")
            gs.combat._npc_steal_logs(pid, npc_id, data.get("target_owner"), data.get("target_npc_id"), data.get("str", 1), data.get("amount", 1))

        elif msg_type == "attack_animal":
            gs.combat._try_attack_animal(pid, data.get("animal_id"))

        elif msg_type == "harvest_crop":
            gs.resources._try_harvest_crop(pid, data.get("crop_id"))

        elif msg_type == "plant_seed":
            gs.resources._try_plant_seed(pid, data.get("x"), data.get("y"))

        elif msg_type == "drop_item":
            gs.resources._try_drop_item(pid, data)

        elif msg_type == "pickup_placed":
            gs.resources._try_pickup_placed(pid, data.get("item_id"))

        elif msg_type == "reset_blast_level":
            p["blastLevel"] = 0

        elif msg_type == "set_combat_mode":
            mode = data.get("mode", "kill")
            if mode in ("kill", "ko"):
                p["combat_mode"] = mode

        elif msg_type == "build_ki_target":
            gs.building._try_build_ki_target(pid, data.get("x"), data.get("y"))

        elif msg_type == "delete_ki_target":
            target_id = data.get("target_id")
            if target_id:
                gs.ground_items = [
                    item for item in gs.ground_items
                    if not (item.get("id") == target_id and item.get("resource") == "KiTarget")
                ]

        elif msg_type == "ki_blast_ki_target":
            gs.combat._ki_blast_ki_target(pid, data.get("target_id"), data.get("npc_id"))

        elif msg_type == "activate_barrier":
            gs.combat._activate_barrier(pid, data.get("npc_id"))

        elif msg_type == "set_active_blast":
            blast_id = data.get("blast_id")
            if blast_id is None:
                p["active_blast_id"] = None
            else:
                _KI_MOVE_IDS = {"ki_shot", "absorb", "barrier"}
                from services.combat_ki import BLAST_DEFS as _BD
                if blast_id in _KI_MOVE_IDS or blast_id in _BD:
                    p["active_blast_id"] = blast_id

        elif msg_type == "use_blast_crystal":
            inv = p.setdefault("inventory", {})
            if inv.get("blast_crystal", 0) < 1:
                return
            from services.combat_ki import BLAST_DEFS
            learned = p.setdefault("learned_blasts", [])
            unknown = [bid for bid in BLAST_DEFS if bid not in learned]
            if not unknown:
                # All blasts known — award ki XP instead
                gs.player_manager._grant_ki_skill_xp(p, 50)
                gs.fx_events.append({
                    "type": "chat_hint", "pid": pid,
                    "text": "You already know all blast techniques! You absorb the crystal's energy. (+50 Ki XP)"
                })
            else:
                import random as _random
                new_blast = _random.choice(unknown)
                learned.append(new_blast)
                blast_name = BLAST_DEFS[new_blast].get("displayName", new_blast)
                gs.fx_events.append({
                    "type": "chat_hint", "pid": pid,
                    "text": f"The crystal resonates with your ki! You learned: {blast_name}!"
                })
            inv["blast_crystal"] = inv.get("blast_crystal", 0) - 1
            if inv["blast_crystal"] <= 0:
                del inv["blast_crystal"]

        elif msg_type == "chat":
            text = data.get("text", "")
            if text:
                gs.fx_events.append({
                    "type": "chat",
                    "pid": pid,
                    "text": text[:200],
                    "color": p.get("chatColor", "#cccccc"),
                })
                if "@__ai_rival__" in text:
                    from services.ai_player import ai_player
                    ai_player.receive_message(pid, text.replace("@__ai_rival__", "").strip())

        elif msg_type == "consume_crystal":
            gs.combat._consume_crystal(pid, data.get("npc_id"))

        elif msg_type == "build_npc":
            gs.npc_manager._try_build_npc(pid, data.get("name"))

        elif msg_type == "interact_world_object":
            gs.resources._try_interact_world_object(pid, data.get("wo_id"))

        elif msg_type == "craft_equipment":
            gs.player_manager._try_craft_equipment(pid, data.get("equipment_id"))

        elif msg_type == "equip_item":
            gs.player_manager._try_equip_item(pid, data.get("equipment_id"))
        elif msg_type == "unequip_item":
            gs.player_manager._try_unequip_item(pid, data.get("slot"))
        elif msg_type == "drop_equipment":
            gs.player_manager._try_drop_equipment(pid, data.get("equipment_id"))
        elif msg_type == "npc_pickup_equipment":
            gs.npc_manager._try_npc_pickup_equipment(pid, data.get("npc_id"), data.get("item_id"))

        elif msg_type == "give_npc_equipment":
            gs.npc_manager._try_give_npc_equipment(pid, data.get("npc_id"), data.get("equipment_id"))
        elif msg_type == "take_npc_equipment":
            gs.npc_manager._try_take_npc_equipment(pid, data.get("npc_id"), data.get("slot"))

        elif msg_type == "carry_npc":
            gs.npc_manager._try_carry_npc(pid, data.get("owner_id"), data.get("npc_id"))
        elif msg_type == "carry_own_npc":
            gs.npc_manager._try_carry_npc(pid, pid, data.get("npc_id"))
        elif msg_type == "carry_player":
            gs.player_manager._try_carry_player(pid, data.get("target_id"))
        elif msg_type == "drop_carried":
            gs.player_manager._drop_carried(pid)

        elif msg_type == "sync_npcs":
            gs.npc_manager._sync_player_npcs(pid, data.get("npcs", {}))

        elif msg_type == "register_background_npc":
            npc_id = data.get("npc_id")
            npc_map = data.get("map", "level_01")
            task = data.get("task", {})
            goal = data.get("goal")  # new: multi-step goal
            if npc_id and task:
                gs.background_npcs[npc_id] = {
                    "pid": pid,
                    "npc_id": npc_id,
                    "map": npc_map,
                    "task": task,
                    "goal": goal,
                    "_goal_step": 0,
                    "_tick_count": 0,
                    "_gathered": {},
                    "_xp_gained": 0,
                    "last_tick": time.time(),
                }
                logger.debug("Registered background NPC %s on %s: %s", npc_id, npc_map, task.get('task', '?'))

        elif msg_type == "unregister_background_npcs":
            target_map = data.get("map", "")
            removed = []
            for npc_id, bg in list(gs.background_npcs.items()):
                if bg["pid"] == pid and bg["map"] == target_map:
                    removed.append(npc_id)
                    del gs.background_npcs[npc_id]
                    # Send return briefing if NPC did anything meaningful
                    if bg.get("_gathered") or bg.get("_xp_gained"):
                        gs.fx_events.append({
                            "type": "bg_npc_return",
                            "pid": pid,
                            "npc_id": npc_id,
                            "summary": {
                                "goal_intent": bg.get("goal", {}).get("intent") if bg.get("goal") else None,
                                "ticks": bg.get("_tick_count", 0),
                                "gathered": bg.get("_gathered", {}),
                                "xp_gained": bg.get("_xp_gained", 0),
                            }
                        })
            if removed:
                logger.debug("Unregistered background NPCs on %s: %s", target_map, removed)
