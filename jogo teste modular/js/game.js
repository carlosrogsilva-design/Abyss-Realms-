"use strict";

/* =========================================================
   EVENT BUS
   ========================================================= */
const EventBus = (() => {
  const listeners = {};
  return {
    on(event, callback) {
      (listeners[event] || (listeners[event] = [])).push(callback);
      return callback;
    },
    off(event, callback) {
      if (listeners[event]) listeners[event] = listeners[event].filter(cb => cb !== callback);
    },
    emit(event, payload) {
      (listeners[event] || []).forEach(cb => { try { cb(payload); } catch (e) { console.error(e); } });
    }
  };
})();

const DamageTracker = {
  samples: [],
  record(amount) { this.samples.push({ t: Date.now(), amount }); },
  dps(windowSec = 5) {
    const cutoff = Date.now() - windowSec * 1000;
    this.samples = this.samples.filter(s => s.t >= cutoff);
    return Math.round(this.samples.reduce((s, x) => s + x.amount, 0) / windowSec);
  }
};

const ServiceLocator = (() => {
  const services = new Map();
  return {
    register(key, instance) { services.set(key, instance); },
    get(key) {
      const s = services.get(key);
      if (!s) throw new Error(`Serviço não registrado: ${key}`);
      return s;
    },
    has(key) { return services.has(key); }
  };
})();

/* =========================================================
   GAME LOOP
   ========================================================= */
class GameLoopController {
  constructor() {
    this.systems = [];
    this.running = false;
    this.lastTs = 0;
    this.tickCount = 0;
    this.sessionStartTs = Date.now();
    this._raf = null;
  }
  registerSystem(system) {
    this.systems.push(system);
    system.initialize?.();
    Logger.event(`Sistema registrado: ${system.key}`);
  }
  start() {
    this.running = true;
    this.lastTs = performance.now();
    const loop = (ts) => {
      if (!this.running) return;
      if (document.hidden) { this.lastTs = ts; this._raf = requestAnimationFrame(loop); return; }
      const dt = Math.min(0.25, (ts - this.lastTs) / 1000) * (window.GAME_SPEED || 1);
      this.lastTs = ts;
      this.tickCount++;
      const combatPaused = GameRefs.combatPaused;
      const inter = GameRefs.intermission > 0;
      if (inter && !combatPaused) GameRefs.intermission = Math.max(0, GameRefs.intermission - dt);
      for (const s of this.systems) {
        if (window.EXPEDITION_PAUSED && s.key !== 'PlayerProfile' && s.key !== 'CampProduction') continue;
        if (combatPaused && COMBAT_PAUSED[s.key]) continue;
        if (inter && INTERMISSION_PAUSED[s.key]) continue;
        if (GameRefs.campHold && s.key === 'CampProduction') continue;
        try { s.tick?.(dt); }
        catch (err) {
          this._errs = this._errs || {};
          if (!this._errs[s.key]) { this._errs[s.key] = 1; console.error('[GameLoop] erro em', s.key, err); }
        }
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
    Logger.event("Game loop iniciado");
  }
  pause() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    Logger.event("Game loop pausado");
  }
  resume() { if (!this.running) this.start(); }
  shutdown() { this.pause(); for (const s of this.systems) s.shutdown?.(); }
}

/* =========================================================
   SAVE SYSTEM
   ========================================================= */
const SAVE_VERSION = 1;
const SAVE_KEY = "abyss_idle_save";
const SAVE_SLOTS = [SAVE_KEY, SAVE_KEY + "_2", SAVE_KEY + "_3"];
const MAX_OFFLINE_SECONDS = 12 * 3600;

class SaveManager {
  constructor(key = SAVE_KEY) { this.key = key; this.saveables = []; }
  register(saveable) { this.saveables.push(saveable); }
  buildSaveData() {
    const systems = {};
    for (const s of this.saveables) systems[s.saveKey] = s.captureState();
    return { saveVersion: SAVE_VERSION, lastOnlineTimestamp: Date.now(), systems };
  }
  save() {
    const data = this.buildSaveData();
    try { localStorage.setItem(this.key, JSON.stringify(data)); Logger.event("Save gravado"); return data; }
    catch (e) { Logger.warn("Falha ao salvar: " + e.message); return null; }
  }
  load() {
    let raw;
    try { raw = localStorage.getItem(this.key); }
    catch (e) { Logger.warn("Falha ao ler save: " + e.message); return null; }
    if (!raw) { Logger.event("Nenhum save encontrado"); return null; }
    let data;
    try { data = JSON.parse(raw); }
    catch (e) { Logger.warn("Save corrompido, ignorando"); return null; }
    data = this.migrate(data);
    const elapsedMs = Date.now() - (data.lastOnlineTimestamp || Date.now());
    const elapsedSec = Math.max(0, Math.min(elapsedMs / 1000, MAX_OFFLINE_SECONDS));
    for (const s of this.saveables) {
      const state = data.systems?.[s.saveKey];
      if (state !== undefined) s.restoreState(state);
    }
    Logger.event(`Save carregado (offline: ${Math.round(elapsedSec)}s aplicados)`);
    return { data, elapsedSec };
  }
  migrate(data) {
    if (!data.saveVersion) data.saveVersion = 1;
    return data;
  }
  wipe() { localStorage.removeItem(this.key); Logger.event("Save apagado"); }
}

class PlayerProfileSystem {
  constructor() { this.key = "PlayerProfile"; this.saveKey = "playerProfile"; this.playerId = null; this.createdAt = null; this.totalTicks = 0; }
  initialize() { if (!this.playerId) { this.playerId = "player_" + Math.random().toString(36).slice(2, 10); this.createdAt = Date.now(); } }
  tick(dt) { this.totalTicks++; }
  shutdown() {}
  captureState() { return { playerId: this.playerId, createdAt: this.createdAt, totalTicks: this.totalTicks, autoBattle: GameRefs.autoBattle }; }
  restoreState(state) { this.playerId = state.playerId; this.createdAt = state.createdAt; this.totalTicks = state.totalTicks || 0; GameRefs.autoBattle = !!state.autoBattle; }
}

/* =========================================================
   STATUS EFFECTS
   ========================================================= */
const STATUS_EFFECT_DEFS = {
  burn: { category: "dot", dmgPercentOfSource: 0.15, tickInterval: 1, maxStacks: 1 },
  poison: { category: "dot", dmgPercentOfSource: 0.08, tickInterval: 1, maxStacks: 5 },
  regen: { category: "hot", dmgPercentOfSource: 0.06, tickInterval: 1, maxStacks: 1 },
  stun: { category: "control", maxStacks: 1 },
  weaken: { category: "stat", stat: "def", percent: -0.20, maxStacks: 3 },
  empower: { category: "stat", stat: "atk", percent: 0.15, maxStacks: 3 },
  shield: { category: "shield", maxStacks: 3 }
};

const StatusEffectService = {
  apply(target, typeId, params = {}) {
    const def = STATUS_EFFECT_DEFS[typeId];
    if (!target.statusEffects) target.statusEffects = [];
    const existing = target.statusEffects.find(e => e.typeId === typeId);
    if (existing) {
      existing.remaining = params.duration ?? existing.remaining;
      existing.stacks = Math.min(def.maxStacks, existing.stacks + (params.stacksToAdd || 1));
      if (params.amount) existing.amount = (existing.amount || 0) + params.amount;
      existing.sourcePower = params.sourcePower ?? existing.sourcePower;
    } else {
      target.statusEffects.push({ typeId, category: def.category, remaining: params.duration ?? 3, tickTimer: 0, stacks: 1, sourcePower: params.sourcePower || 0, amount: params.amount || 0 });
    }
    EventBus.emit("OnStatusApplied", { target: target.name || "hero", type: typeId });
  },
  hasControl(target) { return (target.statusEffects || []).some(e => e.category === "control"); },
  statModifier(target, stat) {
    let mult = 1;
    for (const eff of (target.statusEffects || [])) {
      const def = STATUS_EFFECT_DEFS[eff.typeId];
      if (def.category === "stat" && def.stat === stat) mult *= (1 + def.percent * eff.stacks);
    }
    return mult;
  },
  dealDamage(target, amount) {
    let remaining = amount;
    const shield = (target.statusEffects || []).find(e => e.category === "shield");
    if (shield && shield.amount > 0) {
      const absorbed = Math.min(shield.amount, remaining);
      shield.amount -= absorbed;
      remaining -= absorbed;
    }
    target.currentHP = Math.max(0, target.currentHP - remaining);
  },
  tick(target, dt) {
    if (!target.statusEffects || target.statusEffects.length === 0) return;
    if (target.currentHP <= 0) { target.statusEffects = []; return; }
    const maxHP = target.finalStats ? target.finalStats.hp : target.stats.hp;
    for (const eff of target.statusEffects) {
      eff.remaining -= dt;
      const def = STATUS_EFFECT_DEFS[eff.typeId];
      if (def.category === "dot" || def.category === "hot") {
        eff.tickTimer += dt;
        if (eff.tickTimer >= def.tickInterval) {
          eff.tickTimer -= def.tickInterval;
          const amount = Math.round(eff.sourcePower * def.dmgPercentOfSource * eff.stacks);
          if (def.category === "dot") { this.dealDamage(target, amount); Logger.event(`${target.name || "Herói"} sofreu ${amount} de ${eff.typeId}`); }
          else { target.currentHP = Math.min(maxHP, target.currentHP + amount); }
        }
      }
      if (eff.category === "shield" && eff.amount <= 0) eff.remaining = 0;
    }
    target.statusEffects = target.statusEffects.filter(e => e.remaining > 0);
  }
};
/* =========================================================
   DEFINIÇÕES DE HERÓIS, ITENS E PROGRESSÃO
   ========================================================= */
const HERO_DEFINITIONS = {
  warrior: { id: "warrior", name: "Warrior", class: "warrior", baseStats: { hp: 320, atk: 28, def: 18, atkSpeed: 1.0, critRate: 0.05, critDmg: 1.5 } },
  archer: { id: "archer", name: "Archer", class: "archer", baseStats: { hp: 220, atk: 34, def: 10, atkSpeed: 1.3, critRate: 0.15, critDmg: 1.6 } },
  mage: { id: "mage", name: "Mage", class: "mage", baseStats: { hp: 190, atk: 42, def: 8, atkSpeed: 0.8, critRate: 0.10, critDmg: 1.8 } }
};

function statsAtLevel(base, level) {
  const growth = 1 + (level - 1) * 0.08;
  return { hp: Math.round(base.hp * growth), atk: Math.round(base.atk * growth), def: Math.round(base.def * growth), atkSpeed: base.atkSpeed, critRate: base.critRate, critDmg: base.critDmg };
}

const RARITIES = [
  { id: "common", label: "Common", weight: 55, affixCount: 1, rollMult: 1.0 },
  { id: "rare", label: "Rare", weight: 28, affixCount: 2, rollMult: 1.3 },
  { id: "epic", label: "Epic", weight: 13, affixCount: 3, rollMult: 1.7 },
  { id: "legendary", label: "Legendary", weight: 4, affixCount: 4, rollMult: 2.2 }
];

const AFFIX_POOL = [
  { id: "atk_pct", label: "ATK", stat: "atk", type: "percent", min: 0.04, max: 0.12 },
  { id: "hp_pct", label: "HP", stat: "hp", type: "percent", min: 0.04, max: 0.12 },
  { id: "def_pct", label: "DEF", stat: "def", type: "percent", min: 0.05, max: 0.15 },
  { id: "crit_rate", label: "Crit Rate", stat: "critRate", type: "flat", min: 0.01, max: 0.05 },
  { id: "crit_dmg", label: "Crit Dmg", stat: "critDmg", type: "flat", min: 0.03, max: 0.10 }
];

function pickRarity() {
  const total = RARITIES.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total;
  for (const r of RARITIES) { if (roll < r.weight) return r; roll -= r.weight; }
  return RARITIES[0];
}

function rollAffix(depth, rollMult) {
  const def = AFFIX_POOL[Math.floor(Math.random() * AFFIX_POOL.length)];
  const depthScale = 1 + (depth - 1) * 0.03;
  const value = (def.min + Math.random() * (def.max - def.min)) * rollMult * depthScale;
  return { id: def.id, label: def.label, stat: def.stat, type: def.type, value };
}

let _itemSeq = 0;
function generateItem(depth, slot) {
  const rarity = pickRarity();
  const affixes = [];
  for (let i = 0; i < rarity.affixCount; i++) affixes.push(rollAffix(depth, rarity.rollMult));
  return { id: "item_" + (++_itemSeq) + "_" + Math.random().toString(36).slice(2, 6), slot, rarityId: rarity.id, rarityLabel: rarity.label, name: `${rarity.label} ${slot === "weapon" ? "Weapon" : "Armor"}`, affixes };
}

const EquipmentLayer = {
  apply(stats, equipment) {
    const out = { ...stats }, flatAdd = {}, pctAdd = {};
    for (const slot in equipment) {
      const item = equipment[slot]; if (!item) continue;
      const up = 1 + (Number(item.upgradeBonus) || 0);
      for (const aff of item.affixes) {
        if (aff.type === "flat") flatAdd[aff.stat] = (flatAdd[aff.stat] || 0) + aff.value * up;
        else pctAdd[aff.stat] = (pctAdd[aff.stat] || 0) + aff.value * up;
      }
    }
    for (const stat in out) {
      if (pctAdd[stat]) out[stat] = out[stat] * (1 + pctAdd[stat]);
      if (flatAdd[stat]) out[stat] = out[stat] + flatAdd[stat];
      if (stat === "hp" || stat === "atk" || stat === "def") out[stat] = Math.round(out[stat]);
    }
    return out;
  }
};

const GEM_TYPES = [
  { id: "ruby", label: "Ruby", stat: "atk", type: "percent", perLevel: 0.03 },
  { id: "sapphire", label: "Sapphire", stat: "def", type: "percent", perLevel: 0.04 },
  { id: "topaz", label: "Topaz", stat: "hp", type: "percent", perLevel: 0.03 },
  { id: "emerald", label: "Emerald", stat: "critRate", type: "flat", perLevel: 0.008 },
  { id: "amethyst", label: "Amethyst", stat: "critDmg", type: "flat", perLevel: 0.02 }
];
const GEM_SOCKETS_PER_HERO = 3;
let _gemSeq = 0;
function generateGem() {
  const def = GEM_TYPES[Math.floor(Math.random() * GEM_TYPES.length)];
  return { id: "gem_" + (++_gemSeq) + "_" + Math.random().toString(36).slice(2, 6), typeId: def.id, level: 1 };
}
const GemService = {
  gemValue(gem) { const def = GEM_TYPES.find(g => g.id === gem.typeId); return { stat: def.stat, type: def.type, value: def.perLevel * gem.level, label: def.label }; },
  canCombine(a, b) { return a.id !== b.id && a.typeId === b.typeId && a.level === b.level; },
  combine(a, b) { return { id: "gem_" + (++_gemSeq) + "_" + Math.random().toString(36).slice(2, 6), typeId: a.typeId, level: a.level + 1 }; },
  equip(hero, gem, socketIndex) { hero.gemSlots[socketIndex] = gem; },
  remove(hero, socketIndex) { hero.gemSlots[socketIndex] = null; }
};
const GemLayer = {
  apply(stats, gemSlots) {
    const out = { ...stats }, flatAdd = {}, pctAdd = {};
    for (const gem of gemSlots) {
      if (!gem) continue;
      const v = GemService.gemValue(gem);
      if (v.type === "flat") flatAdd[v.stat] = (flatAdd[v.stat] || 0) + v.value;
      else pctAdd[v.stat] = (pctAdd[v.stat] || 0) + v.value;
    }
    for (const stat in out) {
      if (pctAdd[stat]) out[stat] = out[stat] * (1 + pctAdd[stat]);
      if (flatAdd[stat]) out[stat] = out[stat] + flatAdd[stat];
      if (stat === "hp" || stat === "atk" || stat === "def") out[stat] = Math.round(out[stat]);
    }
    return out;
  }
};

const CARD_DEFINITIONS = [
  { id: "ember_wyrm", name: "Ember Wyrm", effect: "burn", stat: { stat: "atk", type: "percent", perLevel: 0.02 } },
  { id: "twin_fang", name: "Twin Fang", effect: "double_cast", stat: { stat: "atkSpeed", type: "percent", perLevel: 0.01 } },
  { id: "ashbound_colossus", name: "Ashbound Colossus", effect: "elemental_amp", stat: { stat: "hp", type: "percent", perLevel: 0.02 } }
];
let _cardSeq = 0;
function generateCard() {
  const def = CARD_DEFINITIONS[Math.floor(Math.random() * CARD_DEFINITIONS.length)];
  const stars = 1 + Math.floor(Math.random() * 5) === 0 ? 1 : (1 + Math.floor(Math.random() * 3));
  return { id: "card_" + (++_cardSeq) + "_" + Math.random().toString(36).slice(2, 6), defId: def.id, level: 1, stars: Math.max(1, Math.min(5, stars)) };
}
const CardService = {
  def(card) { return CARD_DEFINITIONS.find(d => d.id === card.defId); },
  statValue(card) { const d = this.def(card); return { stat: d.stat.stat, type: d.stat.type, value: d.stat.perLevel * card.level * card.stars }; },
  equip(hero, card) { hero.card = card; hero.recalculate(); },
  maxLevel(card) { return 10; },
  canCombine(a, b) { return !!a && !!b && a.id !== b.id && a.defId === b.defId && a.stars === b.stars && a.level === b.level && a.level < this.maxLevel(a); },
  combine(a, b) { return { id: "card_" + (++_cardSeq) + "_" + Math.random().toString(36).slice(2, 6), defId: a.defId, level: a.level + 1, stars: a.stars }; },
  upgrade(card) { if (!card || card.level >= this.maxLevel(card)) return false; card.level++; EventBus.emit("OnCardUpgraded", { cardId: card.defId, level: card.level }); return true; }
};
const CardLayer = {
  apply(stats, card) {
    if (!card) return stats;
    const out = { ...stats }, v = CardService.statValue(card);
    if (v.type === "percent") out[v.stat] = out[v.stat] * (1 + v.value);
    else out[v.stat] = out[v.stat] + v.value;
    if (v.stat === "hp" || v.stat === "atk" || v.stat === "def") out[v.stat] = Math.round(out[v.stat]);
    return out;
  }
};

const GameRefs = { inventory: null, petRoster: null, camp: null, prestige: null, godMode: false, intermission: 0, autoBattle: false, combatPaused: false };
const INTERMISSION_PAUSED = { AutoCombat: 1, EnemyAI: 1, BossController: 1, PetController: 1 };
const COMBAT_PAUSED = { AutoCombat: 1, EnemyAI: 1, BossController: 1, PetController: 1, StatusEffects: 1, SkillSystem: 1 };

const PET_DEFINITIONS = [
  { id: "ember_fox", name: "Ember Fox", aura: { stat: "atk", type: "percent", perLevel: 0.015 }, activeEffect: "burst_damage" },
  { id: "stone_turtle", name: "Stone Turtle", aura: { stat: "def", type: "percent", perLevel: 0.02 }, activeEffect: "team_heal" },
  { id: "sprite", name: "Sprite", aura: { stat: "hp", type: "percent", perLevel: 0.015 }, activeEffect: "heal_lowest" }
];
const PET_EVOLUTION_STAGE_LIMITS = [10, 20, 30];
const PET_LEVEL_FOOD_BASE_COST = 10;
const PET_LEVEL_FOOD_GROWTH = 1.35;
let _petSeq = 0;
function generatePet() {
  const def = PET_DEFINITIONS[Math.floor(Math.random() * PET_DEFINITIONS.length)], rarity = pickRarity();
  return { id: "pet_" + (++_petSeq) + "_" + Math.random().toString(36).slice(2, 6), defId: def.id, level: 1, evolutionStage: 1, levelLimit: PET_EVOLUTION_STAGE_LIMITS[0], rarityId: rarity.id, rarityLabel: rarity.label };
}
const PetService = {
  def(pet) { return PET_DEFINITIONS.find(d => d.id === pet.defId); },
  setActive(roster, petId) { if (roster.activeId && roster.activeId !== petId && !roster.benchIds.includes(roster.activeId)) roster.benchIds.push(roster.activeId); roster.benchIds = roster.benchIds.filter(id => id !== petId); roster.activeId = petId; },
  addToBench(roster, petId) { if (petId !== roster.activeId && !roster.benchIds.includes(petId)) roster.benchIds.push(petId); },
  allOwnedPets(roster, inventory) { const ids = [roster.activeId, ...roster.benchIds].filter(Boolean); return ids.map(id => inventory.findPetById(id)).filter(Boolean); },
  evolutionStage(pet) { return Math.min(PET_EVOLUTION_STAGE_LIMITS.length, Math.max(1, pet.evolutionStage || 1)); },
  maxLevel(pet) { return PET_EVOLUTION_STAGE_LIMITS[this.evolutionStage(pet) - 1]; },
  syncEvolutionState(pet) { if (!pet) return null; pet.evolutionStage = this.evolutionStage(pet); pet.levelLimit = this.maxLevel(pet); pet.level = Math.min(pet.level || 1, pet.levelLimit); return pet; },
  upgradeFoodCost(pet) { if (!pet) return Infinity; return Math.ceil(PET_LEVEL_FOOD_BASE_COST * Math.pow(PET_LEVEL_FOOD_GROWTH, Math.max(0, (pet.level || 1) - 1))); },
  upgrade(pet, camp) { this.syncEvolutionState(pet); if (!pet || !camp || pet.level >= this.maxLevel(pet)) return false; const cost = this.upgradeFoodCost(pet); if (camp.food < cost) return false; camp.food -= cost; pet.level++; EventBus.emit("OnPetUpgraded", { petId: pet.defId, level: pet.level, foodSpent: cost }); return true; }
};
const PetEvolutionSelection = {
  create() { return { mainPetId: null, materialPetIds: [] }; },
  selectMain(selection, petId) { if (!petId || selection.materialPetIds.includes(petId)) return false; selection.mainPetId = petId; return true; },
  addMaterial(selection, petId) { if (!petId || petId === selection.mainPetId || selection.materialPetIds.includes(petId) || selection.materialPetIds.length >= 5) return false; selection.materialPetIds.push(petId); return true; },
  removeMaterial(selection, petId) { const index = selection.materialPetIds.indexOf(petId); if (index < 0) return false; selection.materialPetIds.splice(index, 1); return true; },
  isComplete(selection) { return !!selection.mainPetId && selection.materialPetIds.length === 5; }
};
const PetEvolutionService = {
  confirmAndEvolve(selection, inventory, confirmFn = message => confirm(message)) {
    if (!PetEvolutionSelection.isComplete(selection)) return false;
    const main = inventory.findPetById(selection.mainPetId), materials = selection.materialPetIds.map(id => inventory.findPetById(id));
    if (!main || materials.some(pet => !pet) || PetService.evolutionStage(main) >= PET_EVOLUTION_STAGE_LIMITS.length) return false;
    if (!confirmFn('Sacrificar os 5 pets selecionados para evoluir este pet? A raridade do pet principal será preservada.')) return false;
    for (const materialId of selection.materialPetIds) inventory.removePet(materialId);
    main.evolutionStage = PetService.evolutionStage(main) + 1; main.level = 1; PetService.syncEvolutionState(main);
    EventBus.emit("OnPetEvolved", { petId: main.defId, stage: main.evolutionStage });
    selection.mainPetId = null; selection.materialPetIds = [];
    return true;
  }
};
const PetAuraLayer = {
  apply(stats, roster, inventory) {
    if (!roster || !inventory) return stats;
    const out = { ...stats }, pctAdd = {};
    for (const pet of PetService.allOwnedPets(roster, inventory)) { const def = PetService.def(pet); pctAdd[def.aura.stat] = (pctAdd[def.aura.stat] || 0) + def.aura.perLevel * pet.level; }
    for (const stat in out) {
      if (pctAdd[stat]) out[stat] = out[stat] * (1 + pctAdd[stat]);
      if (stat === "hp" || stat === "atk" || stat === "def") out[stat] = Math.round(out[stat]);
    }
    return out;
  }
};

const CAMP_BUILDINGS = {
  storage: { name: "Storage", baseCost: 50, costGrowth: 1.5, baseCapacity: 500, capacityPerLevel: 250 },
  smithy: { name: "Smithy", baseCost: 80, costGrowth: 1.6, baseProd: 0.5, prodPerLevel: 0.3 },
  cooking: { name: "Cooking", baseCost: 60, costGrowth: 1.5, baseProd: 0.3, prodPerLevel: 0.2 },
  levistone: { name: "Levistone", baseCost: 150, costGrowth: 1.9, statPerLevel: 0.02 }
};
const CURRENCIES = ["gold", "materials", "diamonds", "eventTokens", "petEssence"];
const CurrencyService = {
  getBalance(camp, currency) { return camp.currencies[currency] || 0; },
  hasCurrency(camp, currency, amount) { return this.getBalance(camp, currency) >= amount; },
  canAfford(camp, currency, amount) { return this.hasCurrency(camp, currency, amount); },
  addCurrency(camp, currency, amount) { if (amount <= 0) return; camp.currencies[currency] = (camp.currencies[currency] || 0) + amount; },
  removeCurrency(camp, currency, amount) { if (!this.hasCurrency(camp, currency, amount)) return false; camp.currencies[currency] -= amount; return true; }
};
const CampService = {
  upgradeCost(id, camp) { const def = CAMP_BUILDINGS[id], level = camp.buildingLevels[id]; return Math.round(def.baseCost * Math.pow(def.costGrowth, level - 1)); },
  canUpgrade(id, camp) { return CurrencyService.canAfford(camp, "gold", this.upgradeCost(id, camp)); },
  collect(camp) { const cap = this.storageCapacity(camp), p = camp.pending; const materials = Math.max(0, Math.min(p.materials, cap - camp.materials)); const food = Math.max(0, Math.min(p.food, cap - camp.food)); if (materials > 0) CurrencyService.addCurrency(camp, "materials", materials); camp.food += food; p.materials -= materials; p.food -= food; return { materials, food }; },
  upgrade(id, camp) { if (!this.canUpgrade(id, camp)) return false; CurrencyService.removeCurrency(camp, "gold", this.upgradeCost(id, camp)); camp.buildingLevels[id]++; EventBus.emit("OnBuildingUpgraded", { buildingId: id, level: camp.buildingLevels[id] }); return true; },
  storageCapacity(camp) { const def = CAMP_BUILDINGS.storage; return def.baseCapacity + def.capacityPerLevel * (camp.buildingLevels.storage - 1); }
};
const LevistoneLayer = {
  apply(stats, camp) {
    if (!camp) return stats;
    const bonus = CAMP_BUILDINGS.levistone.statPerLevel * (camp.buildingLevels.levistone - 1);
    if (bonus <= 0) return stats;
    const out = { ...stats }; out.atk = Math.round(out.atk * (1 + bonus)); return out;
  }
};

const PRESTIGE_CONFIG = { minDepthToRebirth: 15, pointBonusPerPoint: 0.01 };
const PrestigeService = {
  canRebirth(abyss) { return abyss.best >= PRESTIGE_CONFIG.minDepthToRebirth; },
  calcPoints(abyss) { return Math.max(1, Math.floor(abyss.best / 3)); },
  rebirth(prestige, abyss, team) { if (!this.canRebirth(abyss)) return false; prestige.points += this.calcPoints(abyss); prestige.rebirthCount++; abyss.depth = 1; abyss.kills = 0; abyss.best = 1; abyss.farm = false; abyss.bossReady = false; for (const h of team) { h.level = 1; h.experience = 0; h.currentHP = h.finalStats?.hp || 1; } return true; }
};
const PrestigeLayer = {
  apply(stats, prestige) {
    if (!prestige || prestige.points <= 0) return stats;
    const bonus = prestige.points * PRESTIGE_CONFIG.pointBonusPerPoint, out = { ...stats };
    out.atk = Math.round(out.atk * (1 + bonus)); out.hp = Math.round(out.hp * (1 + bonus)); out.def = Math.round(out.def * (1 + bonus)); return out;
  }
};

const TALENT_ICON_MAP = { iron_skin: 'assets/talent-iron_skin.png', berserk: 'assets/talent-berserk.png', vitality_w: 'assets/talent-vitality_w.png', precision: 'assets/talent-precision.png', swift: 'assets/talent-swift.png', vitality_a: 'assets/talent-vitality_a.png', power: 'assets/talent-power.png', focus: 'assets/talent-focus.png', vitality_m: 'assets/talent-vitality_m.png' };
const TALENT_TREES = {
  warrior: [{ id: "iron_skin", label: "Iron Skin", stat: "def", perRank: 0.04, maxRank: 5 }, { id: "berserk", label: "Berserk", stat: "atk", perRank: 0.03, maxRank: 5 }, { id: "vitality_w", label: "Vitality", stat: "hp", perRank: 0.03, maxRank: 5 }],
  archer: [{ id: "precision", label: "Precision", stat: "atk", perRank: 0.03, maxRank: 5 }, { id: "swift", label: "Swift", stat: "atkSpeed", perRank: 0.03, maxRank: 5 }, { id: "vitality_a", label: "Vitality", stat: "hp", perRank: 0.025, maxRank: 5 }],
  mage: [{ id: "power", label: "Power", stat: "atk", perRank: 0.035, maxRank: 5 }, { id: "focus", label: "Focus", stat: "critRate", perRank: 0.015, maxRank: 5 }, { id: "vitality_m", label: "Vitality", stat: "hp", perRank: 0.025, maxRank: 5 }]
};
const TalentLayer = {
  apply(stats, hero) {
    const tree = TALENT_TREES[hero.classId], out = { ...stats };
    for (const node of tree) {
      const rank = hero.talents[node.id] || 0; if (rank === 0) continue;
      const bonus = node.perRank * rank; out[node.stat] = node.stat === "critRate" ? out[node.stat] + bonus : out[node.stat] * (1 + bonus);
    }
    out.hp = Math.round(out.hp); out.atk = Math.round(out.atk); out.def = Math.round(out.def); return out;
  }
};

const StatCalculator = {
  computeFinalStats(heroInstance) {
    const def = HERO_DEFINITIONS[heroInstance.classId];
    let stats = statsAtLevel(def.baseStats, heroInstance.level);
    stats = EquipmentLayer.apply(stats, heroInstance.equipment);
    stats = GemLayer.apply(stats, heroInstance.gemSlots);
    stats = CardLayer.apply(stats, heroInstance.card);
    stats = PetAuraLayer.apply(stats, GameRefs.petRoster, GameRefs.inventory);
    stats = LevistoneLayer.apply(stats, GameRefs.camp);
    stats = TalentLayer.apply(stats, heroInstance);
    stats = PrestigeLayer.apply(stats, GameRefs.prestige);
    return stats;
  }
};

class HeroInstance {
  constructor(classId, level = 1) {
    this.instanceId = classId + "_" + Math.random().toString(36).slice(2, 8); this.classId = classId; this.level = level; this.experience = 0;
    this.equipment = { weapon: null, armor: null }; this.gemSlots = new Array(GEM_SOCKETS_PER_HERO).fill(null); this.card = null;
    this.talents = {}; this.talentPoints = 0; this.statusEffects = [];
    this.finalStats = StatCalculator.computeFinalStats(this); this.currentHP = this.finalStats.hp; this._atkTimer = 0;
  }
  get name() { return HERO_DEFINITIONS[this.classId].name; }
  get isAlive() { return this.currentHP > 0; }
  recalculate() {
    const maxHpBefore = this.finalStats.hp; this.finalStats = StatCalculator.computeFinalStats(this);
    const diff = this.finalStats.hp - maxHpBefore;
    this.currentHP = this.currentHP <= 0 ? 0 : Math.min(this.finalStats.hp, this.currentHP + Math.max(0, diff));
  }
  equipItem(item) { this.equipment[item.slot] = item; this.recalculate(); EventBus.emit("OnEquipmentEquipped", { hero: this.name, item: item.name, slot: item.slot }); }
  xpToNextLevel() { return Math.round(100 * Math.pow(1.15, this.level - 1)); }
  gainExperience(amount) {
    this.experience += amount; let leveledUp = false;
    while (this.experience >= this.xpToNextLevel()) { this.experience -= this.xpToNextLevel(); this.level++; this.talentPoints++; leveledUp = true; }
    if (leveledUp) { this.recalculate(); EventBus.emit("OnHeroLevelUp", { hero: this, level: this.level }); }
    return leveledUp;
  }
  spendTalent(nodeId) {
    const node = TALENT_TREES[this.classId].find(n => n.id === nodeId);
    if (!node || this.talentPoints <= 0) return false;
    const current = this.talents[nodeId] || 0;
    if (current >= node.maxRank) return false;
    this.talents[nodeId] = current + 1; this.talentPoints--; this.recalculate(); return true;
  }
}

const DamageSystem = {
  computeDamage(attackerStats) { let dmg = attackerStats.atk; const isCrit = Math.random() < attackerStats.critRate; if (isCrit) dmg *= attackerStats.critDmg; return { amount: Math.round(dmg), isCrit }; },
  applyMitigation(rawAmount, defenderStats) { const mitigation = defenderStats.def / (defenderStats.def + 100); const finalDmg = Math.max(rawAmount * 0.1, rawAmount * (1 - mitigation)); return Math.round(finalDmg); }
};

const ENEMY_DEFINITIONS = [
  { id: "silt_crawler", name: "Silt Crawler", minDepth: 1, stats: { hp: 50, atk: 5, def: 2, atkSpeed: 0.8 } },
  { id: "bog_wretch", name: "Bog Wretch", minDepth: 1, stats: { hp: 70, atk: 7, def: 3, atkSpeed: 0.6 } },
  { id: "rustfin_skirmisher", name: "Rustfin Skirmisher", minDepth: 4, stats: { hp: 85, atk: 9, def: 5, atkSpeed: 1.1 } },
  { id: "hollow_warden", name: "Hollow Warden", minDepth: 6, stats: { hp: 140, atk: 8, def: 9, atkSpeed: 0.5 } },
  { id: "marrow_eel", name: "Marrow Eel", minDepth: 8, stats: { hp: 75, atk: 11, def: 3, atkSpeed: 1.5 } },
  { id: "choir_of_bones", name: "Choir of Bones", minDepth: 11, stats: { hp: 180, atk: 7, def: 4, atkSpeed: 0.9 } },
  { id: "tideclaw_brute", name: "Tideclaw Brute", minDepth: 13, stats: { hp: 170, atk: 15, def: 7, atkSpeed: 0.6 } },
  { id: "drowned_cultist", name: "Drowned Cultist", minDepth: 16, stats: { hp: 100, atk: 17, def: 5, atkSpeed: 0.9 } },
  { id: "abyssal_leech", name: "Abyssal Leech", minDepth: 19, stats: { hp: 220, atk: 12, def: 6, atkSpeed: 0.7 } },
  { id: "voidscale_sentinel", name: "Voidscale Sentinel", minDepth: 23, stats: { hp: 260, atk: 16, def: 12, atkSpeed: 0.6 } },
  { id: "deepmaw_colossus", name: "Deepmaw Colossus", minDepth: 26, stats: { hp: 320, atk: 19, def: 14, atkSpeed: 0.5 } },
  { id: "null_revenant", name: "Null Revenant", minDepth: 28, stats: { hp: 190, atk: 24, def: 8, atkSpeed: 1.3 } }
];

class EnemyInstance {
  constructor(def) {
    this.id = "enemy_" + Math.random().toString(36).slice(2, 8); this.name = def.name; this.stats = { ...def.stats }; this.baseStats = null;
    this.currentHP = this.stats.hp; this._atkTimer = (1 / (def.stats.atkSpeed || 1)) * 0.55; this.statusEffects = [];
  }
  get isAlive() { return this.currentHP > 0; }
  takeDamage(amount) { StatusEffectService.dealDamage(this, amount); }
}

const ABYSS_CONFIG = { maxDepth: 90, killsToAdvance: 5 };
function getKillsToAdvance() { return (typeof selectedDifficulty !== 'undefined' && selectedDifficulty === 'facil') ? 4 : ABYSS_CONFIG.killsToAdvance; }
const BOSS_CRYSTAL_REWARDS = { 5: 3, 10: 10, 15: 5, 20: 15, 25: 7, 30: 25 };
function getBossCrystalReward(depth, difficulty = selectedDifficulty) {
  let base = BOSS_CRYSTAL_REWARDS[depth] || 0;
  if (depth > 30 && depth % 5 === 0) base = 20; // Recompensa para as 60 novas fases
  if (!base) return 0;
  const bonus = difficulty === 'dificil' ? 4 : difficulty === 'normal' ? 2 : 0;
  return base + bonus;
}

const ROOM_TYPES = [
  { id: "monster", weight: 55 }, { id: "elite", weight: 10 }, { id: "treasure", weight: 8 },
  { id: "shrine", weight: 6 }, { id: "resource", weight: 8 }, { id: "trap", weight: 6 },
  { id: "npc", weight: 3 }, { id: "empty", weight: 3 }, { id: "secret", weight: 0.5 }, { id: "special", weight: 0.5 }
];
const ROOM_LABELS = { monster: "Monstro", elite: "Elite", treasure: "Tesouro", shrine: "Santuário", resource: "Recursos", trap: "Armadilha", npc: "NPC Viajante", empty: "Sala Vazia", secret: "Sala Secreta", special: "Evento Especial" };
function rollRoomType() {
  const total = ROOM_TYPES.reduce((s, r) => s + r.weight, 0); let roll = Math.random() * total;
  for (const r of ROOM_TYPES) { if (roll < r.weight) return r.id; roll -= r.weight; }
  return "monster";
}

const BOSS_DEFINITION = {
  id: "abyss_guardian", name: "The Drowned Sovereign", stats: { hp: 400, atk: 18, def: 10, atkSpeed: 0.7 },
  phases: [
    { id: "p1", hpThreshold: 1.00, label: "Fase 1", atkMult: 1.0, defMult: 1.0, atkSpeedMult: 1.0 },
    { id: "p2", hpThreshold: 0.50, label: "Fase 2 — Fúria", atkMult: 1.15, defMult: 1.0, atkSpeedMult: 1.2 },
    { id: "p3", hpThreshold: 0.25, label: "Fase 3 — Invocação", atkMult: 1.15, defMult: 1.3, atkSpeedMult: 1.2, summonBurst: true, applyWeaken: true },
    { id: "p4", hpThreshold: 0.15, label: "Fase Final — Desespero", atkMult: 1.4, defMult: 1.3, atkSpeedMult: 1.5, applyStun: true }
  ]
};

function depthMultiplier(depth) { return 1 + (depth - 1) * 0.15; }
function enemyHpFactor(depth) { return 3 - Math.min(1, Math.max(0, (depth - 1) / (ABYSS_CONFIG.maxDepth - 1))); }
function scaledStats(baseStats, depth, isBoss) {
  const mult = depthMultiplier(depth) * (isBoss ? 3 : 1);
  const stats = { hp: Math.round(baseStats.hp * mult * (isBoss ? 1 : enemyHpFactor(depth))), atk: Math.round(baseStats.atk * mult), def: Math.round(baseStats.def * mult), atkSpeed: baseStats.atkSpeed };
  if (typeof selectedDifficulty !== 'undefined' && selectedDifficulty === 'facil') {
    stats.hp = Math.max(1, Math.round(stats.hp * 0.75)); stats.atk = Math.max(1, Math.round(stats.atk * 0.70));
    stats.def = Math.max(0, Math.round(stats.def * 0.80)); stats.atkSpeed = stats.atkSpeed * 0.85;
  }
  return stats;
}

const isBossPhase = d => d % 5 === 0;
const bossKind = d => d % 10 === 0 ? 'boss' : 'semi';
function spawnEnemyForDepth(depth, bossFight) {
  // 1. Verifica se existe uma fase customizada para este nível
  const customFase = (window.NOVAS_FASES || []).find(f => f.id === depth);
  
  if (bossFight) {
    if (customFase && customFase.boss) {
      const enemy = new EnemyInstance({
        name: customFase.boss.nome,
        stats: { hp: 100, atk: 10, def: 5, atkSpeed: 0.8 }
      });
      enemy.stats = scaledStats(enemy.stats, depth, true);
      enemy.stats.hp = Math.round(enemy.stats.hp * customFase.boss.hpMult);
      enemy.stats.atk = Math.round(enemy.stats.atk * customFase.boss.atkMult);
      enemy.currentHP = enemy.stats.hp;
      enemy.isBoss = true;
      if (customFase.boss.sprite) enemy.customSprite = customFase.boss.sprite;
      return enemy;
    }
    
    // Lógica original para bosses < 30
    if (bossKind(depth) === 'boss') {
      const enemy = new EnemyInstance(BOSS_DEFINITION);
      enemy.stats = scaledStats(BOSS_DEFINITION.stats, depth, true);
      enemy.currentHP = enemy.stats.hp;
      enemy.isBoss = true;
      return enemy;
    }
  }
  
  // 2. Inimigos normais
  let pool = [];
  if (depth > 30 && window.NOVOS_INIMIGOS && window.NOVOS_INIMIGOS.length > 0) {
    pool = window.NOVOS_INIMIGOS.filter(e => depth >= e.minDepth);
  }
  if (pool.length === 0) {
    pool = ENEMY_DEFINITIONS.filter(e => depth >= e.minDepth);
  }
  
  const def = pool[Math.floor(Math.random() * pool.length)];
  
  // Adapta o formato do inimigo (Suporta o original e o novo contrato de dados)
  const enemyDef = {
    name: def.name || def.nome,
    stats: def.stats || def.statsBase
  };
  
  const enemy = new EnemyInstance(enemyDef);
  enemy.stats = scaledStats(enemyDef.stats, depth, false);
  enemy.currentHP = enemy.stats.hp;
  if (def.sprite) enemy.customSprite = def.sprite;
  
  if (bossFight) {
    enemy.stats.hp = Math.round(enemy.stats.hp * 1.6); enemy.currentHP = enemy.stats.hp;
    enemy.stats.atk = Math.round(enemy.stats.atk * 1.4);
    enemy.isElite = true; enemy.isSemiBoss = true; enemy.name = "Semi-Boss " + enemy.name;
  }
  return enemy;
}
function livingEnemies(encounter) { const enemies = encounter?.enemies || (encounter?.current ? [encounter.current] : []); return enemies.filter(enemy => enemy.isAlive); }
function selectLivingEnemy(encounter) { return livingEnemies(encounter)[0] || null; }
function setEncounter(encounter, enemies) { encounter.enemies = enemies; encounter.current = enemies[0] || null; encounter.completionProcessed = false; for (const enemy of enemies) enemy._atkTimer = enemy.isAlive ? 1 / (enemy.stats.atkSpeed || 1) : 0; }
function spawnCommonEncounter(depth) { return Array.from({ length: 3 }, () => spawnEnemyForDepth(depth, false)); }

class StageStarsSystem {
  constructor() { this.saveKey = "stageStars"; this.byDepth = {}; }
  calculate(team) {
    const heroes = (team || []).filter(h => h && h.finalStats && h.finalStats.hp > 0);
    if (!heroes.length) return 1;
    const avgHpRatio = heroes.reduce((sum, h) => sum + Math.max(0, Math.min(1, h.currentHP / h.finalStats.hp)), 0) / heroes.length;
    if (avgHpRatio >= 0.80) return 3; if (avgHpRatio >= 0.50) return 2; return 1;
  }
  record(depth, team) {
    const key = String(Math.max(1, Math.floor(Number(depth) || 1))), earned = this.calculate(team);
    const previous = Math.max(0, Math.min(3, Number(this.byDepth[key]) || 0)), best = Math.max(previous, earned);
    this.byDepth[key] = best;
    Logger.event(`Fase ${key}: ${'★'.repeat(best)}${'☆'.repeat(3 - best)}${best > previous ? ' — novo recorde' : ' — recorde mantido'}`);
    return { earned, previous, best, improved: best > previous };
  }
  get(depth) { return Math.max(0, Math.min(3, Number(this.byDepth[String(depth)]) || 0)); }
  captureState() { return { byDepth: { ...this.byDepth } }; }
  restoreState(state) {
    const input = state && state.byDepth && typeof state.byDepth === 'object' ? state.byDepth : {}; this.byDepth = {};
    for (const [depth, stars] of Object.entries(input)) { const d = Math.floor(Number(depth)), n = Math.floor(Number(stars)); if (d >= 1 && Number.isFinite(d) && n >= 1 && n <= 3) this.byDepth[String(d)] = n; }
  }
}

class AbyssProgress {
  constructor() { this.saveKey = "abyssProgress"; this.depth = 1; this.kills = 0; this.best = 1; this.farm = false; this.bossReady = false; }
  registerKill() {
    if (this.bossReady) { this.bossReady = false; this.kills = 0; return this._completeStage(); }
    this.kills++;
    if (this.kills >= getKillsToAdvance()) {
      if (isBossPhase(this.depth)) { this.kills = getKillsToAdvance(); this.bossReady = true; return { advanced: false, victory: false, bossNext: true }; }
      this.kills = 0; return this._completeStage();
    }
    return { advanced: false, victory: false };
  }
  _completeStage() {
    const done = this.depth;
    if (done >= ABYSS_CONFIG.maxDepth) { EventBus.emit("OnStageCleared", { depth: done, last: true }); return { advanced: false, victory: true }; }
    if (this.farm) { EventBus.emit("OnStageCleared", { depth: done }); return { advanced: false, victory: false, cycled: true }; }
    this.depth++; this.best = Math.max(this.best, this.depth); EventBus.emit("OnStageCleared", { depth: done }); return { advanced: true, victory: false };
  }
  selectDepth(n) { n = Math.floor(n); if (!(n >= 1 && n <= this.best)) return false; this.depth = n; this.kills = 0; this.bossReady = false; this.farm = n < this.best; return true; }
  captureState() { return { depth: this.depth, kills: this.kills, best: this.best, farm: this.farm, bossReady: this.bossReady }; }
  restoreState(state) { this.depth = state.depth || 1; this.kills = state.kills || 0; this.best = Math.max(state.best || 0, this.depth, 1); this.farm = !!state.farm && this.depth < this.best; this.bossReady = !!state.bossReady && isBossPhase(this.depth) && this.kills >= getKillsToAdvance(); }
}

class AutoCombatController {
  constructor(team, encounter, onEnemyDeath) { this.key = "AutoCombat"; this.team = team; this.encounter = encounter; this.onEnemyDeath = onEnemyDeath; }
  initialize() {}
  tick(dt) {
    if (!this.encounter.current) return;
    if (livingEnemies(this.encounter).length === 0) { this.onEnemyDeath(); return; }
    for (const hero of this.team) {
      if (!hero.isAlive || StatusEffectService.hasControl(hero)) continue;
      hero._atkTimer += dt; const interval = 1 / hero.finalStats.atkSpeed;
      if (hero._atkTimer >= interval) {
        hero._atkTimer -= interval; const enemy = selectLivingEnemy(this.encounter);
        if (!enemy) { this.onEnemyDeath(); break; }
        this._performHit(hero, enemy);
        if (hero.card?.effect === "double_cast" && Math.random() < 0.25 && enemy.isAlive) this._performHit(hero, enemy);
        if (livingEnemies(this.encounter).length === 0) { this.onEnemyDeath(); break; }
      }
    }
  }
  shutdown() {}
  _performHit(hero, enemy) {
    const atkMult = StatusEffectService.statModifier(hero, "atk"), defMult = StatusEffectService.statModifier(enemy, "def");
    const { amount, isCrit } = DamageSystem.computeDamage({ ...hero.finalStats, atk: hero.finalStats.atk * atkMult });
    const final = DamageSystem.applyMitigation(amount, { def: enemy.stats.def * defMult });
    enemy.takeDamage(final); DamageTracker.record(final);
    Logger.event(`${hero.name} causou ${final} dano${isCrit ? " (CRÍTICO)" : ""}`);
    if (hero.card?.effect === "burn") StatusEffectService.apply(enemy, "burn", { duration: 3, sourcePower: hero.finalStats.atk });
  }
}

class EnemyAIController {
  constructor(team, encounter) { this.key = "EnemyAI"; this.team = team; this.encounter = encounter; }
  initialize() {}
  tick(dt) {
    if (!this.team.some(h => h.isAlive)) return;
    for (const enemy of livingEnemies(this.encounter)) {
      if (StatusEffectService.hasControl(enemy)) continue;
      const alive = this.team.filter(h => h.isAlive); if (alive.length === 0) break;
      enemy._atkTimer += dt; const interval = 1 / enemy.stats.atkSpeed;
      if (enemy._atkTimer >= interval) {
        enemy._atkTimer -= interval; const targetHero = alive[Math.floor(Math.random() * alive.length)];
        const atkMult = StatusEffectService.statModifier(enemy, "atk");
        const { amount, isCrit } = DamageSystem.computeDamage({ ...enemy.stats, atk: enemy.stats.atk * atkMult, critRate: 0.05, critDmg: 1.5 });
        const defMult = StatusEffectService.statModifier(targetHero, "def");
        const final = DamageSystem.applyMitigation(amount, { def: targetHero.finalStats.def * defMult });
        if (UI.screen === "abyss") UI.lunge("enemy-" + enemy.id, targetHero.instanceId, 180);
        if (!GameRefs.godMode) StatusEffectService.dealDamage(targetHero, final);
        Logger.event(`${enemy.name} causou ${final} dano em ${targetHero.name}${isCrit ? " (CRÍTICO)" : ""}`);
      }
    }
  }
  shutdown() {}
}

const SKILL_DEFINITIONS = {
  warrior: { id: "power_strike", name: "Power Strike", cooldown: 10, multiplier: 2.2 },
  archer: { id: "aimed_shot", name: "Aimed Shot", cooldown: 10, multiplier: 2.6 },
  mage: { id: "fireball", name: "Fireball", cooldown: 10, multiplier: 3.0 }
};

class SkillSystem {
  constructor(team, encounter) {
    this.key = "SkillSystem"; this.team = team; this.encounter = encounter; this.cooldowns = {};
    for (const h of team) this.cooldowns[h.instanceId] = 0;
    this.autoCastInterval = 1.5; this.autoCastTimer = 0; this.autoCastIndex = 0;
  }
  initialize() {}
  tick(dt) {
    for (const id in this.cooldowns) if (this.cooldowns[id] > 0) this.cooldowns[id] = Math.max(0, this.cooldowns[id] - dt);
    if (!GameRefs.autoBattle || GameRefs.combatPaused || GameRefs.intermission > 0) return;
    this.autoCastTimer = Math.max(0, this.autoCastTimer - dt);
    if (this.autoCastTimer > 0 || this.team.length === 0) return;
    for (let offset = 0; offset < this.team.length; offset++) {
      const index = (this.autoCastIndex + offset) % this.team.length, hero = this.team[index];
      if (this.canCast(hero) && this.castSkill(hero)) { this.autoCastIndex = (index + 1) % this.team.length; this.autoCastTimer = this.autoCastInterval; break; }
    }
  }
  shutdown() {}
  canCast(hero) { return !GameRefs.combatPaused && GameRefs.intermission <= 0 && hero.isAlive && this.cooldowns[hero.instanceId] <= 0 && !StatusEffectService.hasControl(hero); }
  castSkill(hero) {
    const enemy = selectLivingEnemy(this.encounter);
    if (!this.canCast(hero) || !enemy || !enemy.isAlive) return;
    const skillDef = SKILL_DEFINITIONS[hero.classId], cardMult = hero.card?.effect === "elemental_amp" ? 1.3 : 1;
    const boostedStats = { ...hero.finalStats, atk: hero.finalStats.atk * skillDef.multiplier * cardMult };
    const { amount, isCrit } = DamageSystem.computeDamage(boostedStats);
    const final = DamageSystem.applyMitigation(amount, enemy.stats);
    enemy.takeDamage(final); DamageTracker.record(final); this.cooldowns[hero.instanceId] = skillDef.cooldown;
    EventBus.emit("OnSkillUsed", { hero: hero.name, skill: skillDef.name, damage: final });
    Logger.event(`${hero.name} usou ${skillDef.name}: ${final} dano${isCrit ? " (CRÍTICO)" : ""}`);
    return true;
  }
}

class InventorySystem {
  constructor() { this.saveKey = "inventory"; this.items = []; this.gems = []; this.cards = []; this.pets = []; }
  addItem(item) { this.items.push(item); }
  removeItem(itemId) { this.items = this.items.filter(i => String(i.id) !== String(itemId)); }
  findById(itemId) { return this.items.find(i => String(i.id) === String(itemId)) || null; }
  addGem(gem) { this.gems.push(gem); }
  removeGem(gemId) { this.gems = this.gems.filter(g => g.id !== gemId); }
  findGemById(gemId) { return this.gems.find(g => g.id === gemId) || null; }
  addCard(card) { this.cards.push(card); }
  removeCard(cardId) { this.cards = this.cards.filter(c => c.id !== cardId); }
  findCardById(cardId) { return this.cards.find(c => c.id === cardId) || null; }
  addPet(pet) { this.pets.push(pet); }
  removePet(petId) { this.pets = this.pets.filter(p => p.id !== petId); }
  findPetById(petId) { return this.pets.find(p => p.id === petId) || null; }
  captureState() { return { items: this.items, gems: this.gems, cards: this.cards, pets: this.pets }; }
  restoreState(state) { this.items = state.items || []; this.gems = state.gems || []; this.cards = state.cards || []; this.pets = state.pets || []; this.pets.forEach(pet => PetService.syncEvolutionState(pet)); }
}

class TeamSaveSystem {
  constructor(team, inventory) { this.saveKey = "team"; this.team = team; this.inventory = inventory; }
  captureState() {
    return { heroes: this.team.map(h => ({ classId: h.classId, level: h.level, equipment: { weapon: h.equipment.weapon ? h.equipment.weapon.id : null, armor: h.equipment.armor ? h.equipment.armor.id : null }, gemSlots: h.gemSlots.map(g => g ? g.id : null), card: h.card ? h.card.id : null, experience: h.experience, talents: h.talents, talentPoints: h.talentPoints })) };
  }
  restoreState(state) {
    for (const entry of (state.heroes || [])) {
      const hero = this.team.find(h => h.classId === entry.classId); if (!hero) continue;
      hero.level = entry.level || 1; hero.experience = entry.experience || 0; hero.talents = entry.talents || {}; hero.talentPoints = entry.talentPoints || 0;
      const weapon = entry.equipment?.weapon ? this.inventory.findById(entry.equipment.weapon) : null;
      const armor = entry.equipment?.armor ? this.inventory.findById(entry.equipment.armor) : null;
      hero.equipment = { weapon, armor };
      hero.gemSlots = (entry.gemSlots || []).map(id => id ? this.inventory.findGemById(id) : null);
      while (hero.gemSlots.length < GEM_SOCKETS_PER_HERO) hero.gemSlots.push(null);
      hero.card = entry.card ? this.inventory.findCardById(entry.card) : null;
      hero.recalculate();
    }
    const order = (state.heroes || []).map(e => e.classId);
    if (order.length === this.team.length && new Set(order).size === order.length && order.every(cid => this.team.some(h => h.classId === cid))) {
      const sorted = order.map(cid => this.team.find(h => h.classId === cid)); this.team.splice(0, this.team.length, ...sorted);
    }
  }
}

class PetSaveSystem {
  constructor(roster) { this.saveKey = "petRoster"; this.roster = roster; }
  captureState() { return { activeId: this.roster.activeId, benchIds: this.roster.benchIds }; }
  restoreState(state) { this.roster.activeId = state.activeId || null; this.roster.benchIds = state.benchIds || []; }
}

class PetController {
  constructor(team, encounter, roster, inventory) { this.key = "PetController"; this.team = team; this.encounter = encounter; this.roster = roster; this.inventory = inventory; this.timer = 0; this.interval = 6; }
  initialize() {}
  tick(dt) {
    if (!this.roster.activeId) return; this.timer += dt; if (this.timer < this.interval) return; this.timer -= this.interval;
    const pet = this.inventory.findPetById(this.roster.activeId); if (!pet) return;
    const def = PetService.def(pet), enemy = selectLivingEnemy(this.encounter);
    if (def.activeEffect === "burst_damage" && enemy?.isAlive) {
      const dmg = Math.round(20 + pet.level * 12); enemy.takeDamage(dmg); Logger.event(`${def.name} causou ${dmg} de dano bruto`);
    } else if (def.activeEffect === "heal_lowest") {
      const alive = this.team.filter(h => h.isAlive); if (alive.length === 0) return;
      const target = alive.reduce((a, b) => (a.currentHP / a.finalStats.hp < b.currentHP / b.finalStats.hp ? a : b));
      const heal = Math.round(target.finalStats.hp * (0.10 + pet.level * 0.02)); target.currentHP = Math.min(target.finalStats.hp, target.currentHP + heal);
      Logger.event(`${def.name} curou ${target.name} em ${heal} HP`);
    } else if (def.activeEffect === "team_heal") {
      for (const h of this.team) {
        if (!h.isAlive) continue; const heal = Math.round(h.finalStats.hp * (0.05 + pet.level * 0.01));
        h.currentHP = Math.min(h.finalStats.hp, h.currentHP + heal); StatusEffectService.apply(h, "shield", { duration: 8, amount: Math.round(h.finalStats.hp * 0.05) });
      }
      Logger.event(`${def.name} curou e protegeu a equipe com um shield`);
    }
  }
  shutdown() {}
}

const CAMP_CONFIG = { foodProductionEnabled: true, materialsProductionEnabled: true };
class CampState {
  constructor() {
    this.saveKey = "camp"; this.currencies = { gold: 100, materials: 0, diamonds: 0, eventTokens: 0, petEssence: 0 };
    this.food = 0; this.pending = { materials: 0, food: 0 }; this.buildingLevels = { storage: 1, smithy: 1, cooking: 1, levistone: 1 }; this.quest = { killTarget: 10, killCurrent: 0, goldReward: 40 };
  }
  get gold() { return this.currencies.gold; }
  get materials() { return this.currencies.materials; }
  captureState() { return { currencies: this.currencies, food: this.food, pending: this.pending, buildingLevels: this.buildingLevels, quest: this.quest }; }
  restoreState(state) {
    this.currencies = state.currencies || { gold: state.gold ?? 100, materials: state.materials ?? 0, diamonds: 0, eventTokens: 0 };
    this.food = state.food ?? 0; this.pending = state.pending || { materials: 0, food: 0 }; this.buildingLevels = state.buildingLevels || this.buildingLevels; this.quest = state.quest || this.quest;
  }
}

class CampController {
  constructor(camp) { this.key = "CampProduction"; this.camp = camp; }
  initialize() {}
  tick(dt) {
    if (UI.screen !== 'abyss' || GameRefs.combatPaused || GameRefs.intermission > 0) return;
    if (!CAMP_CONFIG.foodProductionEnabled && !CAMP_CONFIG.materialsProductionEnabled) return;
    const cap = CampService.storageCapacity(this.camp), p = this.camp.pending;
    if (CAMP_CONFIG.materialsProductionEnabled) { const smithyDef = CAMP_BUILDINGS.smithy; const matProd = smithyDef.baseProd + smithyDef.prodPerLevel * (this.camp.buildingLevels.smithy - 1); p.materials = Math.min(cap, p.materials + matProd * dt); }
    if (CAMP_CONFIG.foodProductionEnabled) { const cookingDef = CAMP_BUILDINGS.cooking; const foodProd = cookingDef.baseProd + cookingDef.prodPerLevel * (this.camp.buildingLevels.cooking - 1); p.food = Math.min(cap, p.food + foodProd * dt); }
    CampService.collect(this.camp);
  }
  shutdown() {}
  registerKill() { if (this.camp.quest.killCurrent < this.camp.quest.killTarget) this.camp.quest.killCurrent++; }
  canClaimQuest() { return this.camp.quest.killCurrent >= this.camp.quest.killTarget; }
  claimQuest() { if (!this.canClaimQuest()) return false; CurrencyService.addCurrency(this.camp, "gold", this.camp.quest.goldReward); this.camp.quest.killCurrent = 0; EventBus.emit("OnQuestCompleted", { reward: this.camp.quest.goldReward }); return true; }
}

const OFFLINE_AVG_TTK = 4;
const OfflineProgressionService = {
  apply(elapsedSec, ctx) {
    const { camp, campController, abyss, team, inventory } = ctx;
    if (elapsedSec < 5) return null;
    const cap = CampService.storageCapacity(camp), smithyDef = CAMP_BUILDINGS.smithy, cookingDef = CAMP_BUILDINGS.cooking;
    const matProd = smithyDef.baseProd + smithyDef.prodPerLevel * (camp.buildingLevels.smithy - 1);
    const foodProd = cookingDef.baseProd + cookingDef.prodPerLevel * (camp.buildingLevels.cooking - 1);
    const materialsGained = CAMP_CONFIG.materialsProductionEnabled ? Math.min(cap - camp.materials, matProd * elapsedSec) : 0;
    const foodGained = CAMP_CONFIG.foodProductionEnabled ? Math.min(cap - camp.food, foodProd * elapsedSec) : 0;
    camp.food += Math.max(0, foodGained); if (materialsGained > 0) CurrencyService.addCurrency(camp, "materials", materialsGained);
    let kills = Math.floor(elapsedSec / OFFLINE_AVG_TTK), goldGained = 0, xpGained = 0, depthsGained = 0;
    const startDepth = abyss.depth;
    for (let i = 0; i < kills; i++) {
      if (abyss.depth >= ABYSS_CONFIG.maxDepth) break;
      const goldDrop = 8 + Math.floor(abyss.depth * 1.5), xpDrop = 5 + abyss.depth;
      goldGained += goldDrop; xpGained += xpDrop; campController.registerKill();
      const result = abyss.registerKill(); if (result.advanced) depthsGained++;
    }
    if (goldGained > 0) CurrencyService.addCurrency(camp, "gold", goldGained);
    let anyLevelUp = false; for (const h of team) { if (h.gainExperience(xpGained)) anyLevelUp = true; }
    return { elapsedSec, kills, goldGained, xpGained, materialsGained: Math.round(Math.max(0, materialsGained)), foodGained: Math.round(Math.max(0, foodGained)), depthFrom: startDepth, depthTo: abyss.depth, anyLevelUp };
  }
};

const BOSS_BLOOD_IMPACT_GIF = "assets/boss-blood-impact.gif";
function showBossBloodImpact(hero) {
  const arena = document.getElementById('arena'), unit = hero && UI.refs[hero.instanceId];
  if (!arena || !unit || UI.screen !== 'abyss') return;
  const c = centerOf(unit), fx = document.createElement('img');
  fx.className = 'boss-blood-impact'; fx.alt = ''; fx.src = BOSS_BLOOD_IMPACT_GIF;
  fx.style.left = (c.cx / Math.max(1, arena.clientWidth) * 100) + '%'; fx.style.top = (c.cy / Math.max(1, arena.clientHeight) * 100) + '%';
  arena.appendChild(fx); triggerSkillImpact(parseFloat(fx.style.left), parseFloat(fx.style.top), true, true); setTimeout(() => fx.remove(), 560);
}

class BossController {
  constructor(team, encounter) { this.key = "BossController"; this.team = team; this.encounter = encounter; this.trackedId = null; this.phaseIndex = 0; }
  initialize() {}
  tick(dt) {
    const enemy = this.encounter.current;
    if (!enemy || !enemy.isAlive || !enemy.isBoss) { this.trackedId = null; return; }
    if (this.trackedId !== enemy.id) { this.trackedId = enemy.id; this.phaseIndex = 0; enemy.baseStats = { ...enemy.stats }; enemy.currentPhaseLabel = BOSS_DEFINITION.phases[0].label; }
    const hpRatio = enemy.currentHP / enemy.baseStats.hp; let newIndex = 0;
    for (let i = 0; i < BOSS_DEFINITION.phases.length; i++) { if (hpRatio <= BOSS_DEFINITION.phases[i].hpThreshold) newIndex = i; }
    if (newIndex > this.phaseIndex) {
      this.phaseIndex = newIndex; const phase = BOSS_DEFINITION.phases[newIndex];
      enemy.stats.atk = Math.round(enemy.baseStats.atk * phase.atkMult); enemy.stats.def = Math.round(enemy.baseStats.def * phase.defMult);
      enemy.stats.atkSpeed = enemy.baseStats.atkSpeed * phase.atkSpeedMult; enemy.currentPhaseLabel = phase.label;
      Logger.event(`${enemy.name} entrou em ${phase.label}!`);
      if (phase.summonBurst) {
        const alive = this.team.filter(h => h.isAlive);
        if (alive.length > 0) {
          const target = alive[Math.floor(Math.random() * alive.length)], dmg = Math.round(enemy.baseStats.atk * 0.8);
          showBossBloodImpact(target); if (!GameRefs.godMode) StatusEffectService.dealDamage(target, dmg);
          if (phase.applyWeaken) StatusEffectService.apply(target, "weaken", { duration: 5 });
          Logger.event(`Invocação de ${enemy.name} atingiu ${target.name} em ${dmg}${phase.applyWeaken ? " (Weaken)" : ""}`);
        }
      }
      if (phase.applyStun) {
        const alive = this.team.filter(h => h.isAlive);
        if (alive.length > 0) {
          const target = alive[Math.floor(Math.random() * alive.length)];
          showBossBloodImpact(target); StatusEffectService.apply(target, "stun", { duration: 2 });
          Logger.event(`${enemy.name} atordoou ${target.name} em desespero!`);
        }
      }
    }
  }
  shutdown() {}
}

const BANNER_DEFINITIONS = [{ id: "standard", name: "Standard Summon", singleCost: 100, multiCost: 900, multiCount: 10, pool: [{ type: "card", weight: 60 }, { type: "pet", weight: 40 }], pityThreshold: 20 }];
function isRarePull(result) { if (result.type === "card") return result.item.stars >= 4; return result.item.rarityId === "epic" || result.item.rarityId === "legendary"; }
function generateGachaCard(guaranteedRare) { const card = generateCard(); if (guaranteedRare && card.stars < 4) card.stars = 4 + Math.floor(Math.random() * 2); return card; }
function generateGachaPet(guaranteedRare) { const pet = generatePet(); if (guaranteedRare && pet.rarityId !== "epic" && pet.rarityId !== "legendary") { const r = Math.random() < 0.75 ? RARITIES.find(r => r.id === "epic") : RARITIES.find(r => r.id === "legendary"); pet.rarityId = r.id; pet.rarityLabel = r.label; } return pet; }
const GachaService = {
  pityCounters: {},
  rollOne(banner, guaranteedRare) { const total = banner.pool.reduce((s, p) => s + p.weight, 0); let roll = Math.random() * total, type = banner.pool[0].type; for (const p of banner.pool) { if (roll < p.weight) { type = p.type; break; } roll -= p.weight; } const item = type === "card" ? generateGachaCard(guaranteedRare) : generateGachaPet(guaranteedRare); return { type, item }; },
  pull(banner, camp, inventory, count) {
    const cost = count === 1 ? banner.singleCost : banner.multiCost; if (!CurrencyService.canAfford(camp, "gold", cost)) return null;
    CurrencyService.removeCurrency(camp, "gold", cost);
    if (this.pityCounters[banner.id] === undefined) this.pityCounters[banner.id] = 0;
    const results = [];
    for (let i = 0; i < count; i++) {
      const forcedRare = this.pityCounters[banner.id] >= banner.pityThreshold - 1, result = this.rollOne(banner, forcedRare);
      results.push(result); if (isRarePull(result)) this.pityCounters[banner.id] = 0; else this.pityCounters[banner.id]++;
      if (result.type === "card") inventory.addCard(result.item); else inventory.addPet(result.item);
      EventBus.emit("OnGachaPull", { bannerId: banner.id, type: result.type });
    }
    return results;
  }
};
class GachaSaveSystem { saveKey = "gachaPity"; captureState() { return { pityCounters: GachaService.pityCounters }; } restoreState(state) { GachaService.pityCounters = state.pityCounters || {}; } }
class PrestigeState { constructor() { this.saveKey = "prestige"; this.points = 0; this.rebirthCount = 0; } captureState() { return { points: this.points, rebirthCount: this.rebirthCount }; } restoreState(state) { this.points = state.points || 0; this.rebirthCount = state.rebirthCount || 0; } }

class StatusEffectController {
  constructor(team, encounter) { this.key = "StatusEffects"; this.team = team; this.encounter = encounter; }
  initialize() {}
  tick(dt) { for (const hero of this.team) StatusEffectService.tick(hero, dt); for (const enemy of (this.encounter.enemies || (this.encounter.current ? [this.encounter.current] : []))) StatusEffectService.tick(enemy, dt); }
  shutdown() {}
}

const ANALYTICS_EVENT_MAP = { OnPlayerLogin: "session_start", OnPlayerLogout: "session_end", OnDepthCompleted: "depth_complete", OnBossDefeated: "boss_kill", OnHeroLevelUp: "hero_level_up", OnBuildingUpgraded: "building_upgrade", OnCardUpgraded: "card_upgrade", OnEquipmentEquipped: "equipment_equip", OnQuestCompleted: "quest_complete", OnPetUpgraded: "pet_upgrade" };
const AnalyticsService = {
  log: [],
  track(name, payload) { this.log.push({ name, payload, t: Date.now() }); if (this.log.length > 200) this.log.shift(); },
  init() {
    for (const busEvent in ANALYTICS_EVENT_MAP) EventBus.on(busEvent, payload => this.track(ANALYTICS_EVENT_MAP[busEvent], payload));
    EventBus.on("OnItemDropped", p => { if (p.kind === "equipment") this.track("equipment_drop", p); });
    EventBus.on("OnCombatStarted", p => { this.track("depth_enter", p); if (p.isBoss) this.track("boss_start", p); });
    EventBus.on("OnGachaPull", p => { if (p.type === "card") this.track("card_pull", p); });
  }
};

const Logger = {
  el: null,
  event(msg) { this._write(msg, "evt"); },
  warn(msg) { this._write(msg, "warn"); },
  _write(msg, cls) {
    if (!this.el) return;
    const line = document.createElement("div"); line.className = cls; line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    this.el.appendChild(line); this.el.scrollTop = this.el.scrollHeight;
  }
};
/* =========================================================
   UI E VARIÁVEIS GLOBAIS
   ========================================================= */
window.GAME_SPEED = 0.85;
const SPEED_LEVELS = [0.85, 1, 2, 3];
const SPEED_LABELS = ["Normal", "x1", "x2", "x3"];
const $ = id => document.getElementById(id);
const UI = { screen:'camp', hi:0, ct:'items', touch:0, encId:null, pulls:[], feed:[], refs:{}, godTouch:0, petEvolution: PetEvolutionSelection.create(), weaponEvolution: { mainWeaponId: null, materialWeaponIds: [] } };
let G;
const fmt = n => Math.floor(n).toLocaleString('pt-BR');
const rc = r => 'r-' + r;
const starR = s => ['common','uncommon','rare','epic','legendary'][Math.min(4, Math.max(0, s - 1))];
const gemR = l => ['uncommon','rare','epic','legendary'][Math.min(3, l - 1)];
const rects = a => a.map(([x,y,w,h,c]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`).join('');

const SPRITES = {
  warrior: [[4,0,3,3,'#e8c19a'],[3,0,5,1,'#5a3a24'],[3,3,5,4,'#7a828c'],[2,4,1,3,'#c74443'],[8,4,1,3,'#8a929c'],[3,7,2,4,'#2c3444'],[6,7,2,4,'#2c3444'],[3,11,2,2,'#3a2c20'],[6,11,2,2,'#3a2c20']],
  archer: [[4,0,3,3,'#e8c19a'],[3,0,5,1,'#3a5a2c'],[3,3,5,4,'#4c6b3a'],[3,7,2,4,'#3a2c20'],[6,7,2,4,'#3a2c20'],[3,11,2,2,'#2a1f16'],[6,11,2,2,'#2a1f16']],
  mage: [[4,0,3,3,'#e8c19a'],[3,0,5,1,'#1f2b40'],[3,3,5,5,'#235fa8'],[3,8,2,3,'#172236'],[6,8,2,3,'#172236'],[3,11,2,2,'#101a2b'],[6,11,2,2,'#101a2b']]
};
const WEAPONS = {
  warrior: [[19,1,1,1,'#eef3f8'],[18,2,2,13,'#c8d2de'],[18,2,1,13,'#eef3f8'],[16,15,6,2,'#d5ad58'],[18,17,2,4,'#5a3a24'],[18,21,2,2,'#d5ad58']],
  archer: [[18,4,1,16,'#e8e2cc'],[19,3,2,2,'#8a5a2b'],[20,5,2,3,'#8a5a2b'],[21,8,1,8,'#8a5a2b'],[21,11,1,3,'#3a2c20'],[20,16,2,3,'#8a5a2b'],[19,19,2,2,'#8a5a2b']],
  mage: [[17,7,2,17,'#7a5c3a'],[17,13,2,1,'#5a3a24'],[15,1,6,6,'#1f6f7c'],[16,2,4,4,'#3fd9e8'],[17,3,1,1,'#eafeff'],[15,2,1,4,'#d5ad58'],[20,2,1,4,'#d5ad58']]
};
const ENEMY_WEAPONS = {
  sword: [[4,5,1,1,'#e6edf3'],[3,6,2,14,'#b9c3cf'],[3,6,1,14,'#e6edf3'],[2,20,4,2,'#8a6a2a'],[3,22,2,3,'#4a3322']],
  rustsword: [[4,5,1,1,'#d9a066'],[3,6,2,14,'#a8703a'],[3,6,1,14,'#c98a4a'],[2,20,4,2,'#6b4a2b'],[3,22,2,3,'#3a2c20']],
  dagger: [[4,12,1,1,'#e6edf3'],[3,13,2,7,'#b9c3cf'],[3,13,1,7,'#e6edf3'],[2,20,4,2,'#6b4a2b'],[3,22,2,3,'#3a2c20']],
  bow: [[5,6,1,15,'#e8e2cc'],[3,5,2,2,'#8a5a2b'],[2,7,2,3,'#8a5a2b'],[1,9,1,10,'#8a5a2b'],[1,12,1,4,'#3a2c20'],[2,19,2,2,'#8a5a2b'],[3,21,2,2,'#8a5a2b']],
  staff: [[3,8,2,17,'#6b4a2b'],[1,2,6,6,'#5b2f86'],[2,3,4,4,'#a05bd6'],[3,4,1,1,'#eadbff'],[1,3,1,4,'#8a6a2a'],[6,3,1,4,'#8a6a2a']],
  crudestaff: [[3,6,2,19,'#5a4328'],[2,3,4,4,'#6b8f3a'],[3,4,1,1,'#c9e08a'],[2,7,4,1,'#3a2c20']]
};
const ENEMY_WEAPON_BY_NAME = { 'Silt Crawler':'dagger', 'Bog Wretch':'crudestaff', 'Rustfin Skirmisher':'rustsword', 'Hollow Warden':'sword', 'Marrow Eel':'dagger', 'Choir of Bones':'bow', 'Tideclaw Brute':'sword', 'Drowned Cultist':'staff', 'Abyssal Leech':'crudestaff', 'Voidscale Sentinel':'sword', 'Deepmaw Colossus':'sword', 'Null Revenant':'staff' };

const PLACEHOLDER_SPRITES = {
  ORC_MOB_001: [ // Goblin Saqueador
    [3,8,1,3,'#c0c8d0'],                                           // adaga
    [2,5,2,1,'#6abf45'],[10,5,2,1,'#6abf45'],                      // orelhas
    [4,4,6,4,'#4f9a35'],[5,5,1,1,'#ffe14d'],[8,5,1,1,'#ffe14d'],[6,7,2,1,'#ffffff'], // cabeça, olhos, dentes
    [5,8,4,3,'#6b4a2b'],[8,10,1,1,'#8a6a3a'],                      // corpo de couro, bolsa
    [4,8,1,2,'#4f9a35'],[9,8,1,2,'#4f9a35'],                       // braços
    [5,11,1,2,'#3d7a28'],[8,11,1,2,'#3d7a28'],                     // pernas
    [4,13,2,1,'#2a1a0a'],[8,13,2,1,'#2a1a0a']                      // pés
  ],
  ORC_MOB_002: [ // Guerreiro da Horda
    [12,2,1,7,'#b8c0c8'],[11,9,3,1,'#5a3a1a'],                     // espada
    [5,10,2,3,'#244f20'],[7,10,2,3,'#244f20'],                     // pernas
    [4,13,3,1,'#1c1c1c'],[7,13,3,1,'#1c1c1c'],                     // botas
    [2,7,2,3,'#2f6b2a'],[10,7,2,3,'#2f6b2a'],                      // braços
    [4,5,6,5,'#4a4f57'],[5,6,4,1,'#7b828c'],[4,9,6,1,'#2a2a2e'],   // armadura, brilho, cinto
    [2,5,2,2,'#6e747c'],[10,5,2,2,'#6e747c'],                      // ombreiras
    [4,2,6,3,'#2f6b2a'],[4,1,6,1,'#5a5f66'],                       // cabeça, elmo
    [5,3,1,1,'#ff4040'],[8,3,1,1,'#ff4040'],[5,4,1,1,'#f2ecd0'],[8,4,1,1,'#f2ecd0'] // olhos, presas
  ],
  ORC_MOB_003: [ // Caçador da Horda (arco desenhado aqui; não depende do arco do motor)
    [10,1,1,1,'#e8e0c8'],[10,2,1,4,'#4a3320'],                     // aljava e flecha
    [0,3,1,8,'#8a5a2a'],[1,2,1,1,'#8a5a2a'],[1,11,1,1,'#8a5a2a'],[1,3,1,8,'#e8e0c8'], // arco e corda
    [5,10,2,3,'#3a2a18'],[7,10,2,3,'#3a2a18'],                     // pernas
    [4,13,3,1,'#241810'],[7,13,3,1,'#241810'],                     // botas
    [4,5,6,5,'#6b5030'],                                           // corpo de couro
    [2,6,2,3,'#3a7a30'],[10,6,2,3,'#3a7a30'],                      // braços
    [4,1,6,2,'#4b6b2f'],[5,3,4,2,'#3a7a30'],[5,3,1,1,'#ffe14d'],[8,3,1,1,'#ffe14d'] // capuz, rosto, olhos
  ],
  ORC_MOB_004: [ // Berserker Sangrento (dois machados erguidos)
    [1,2,1,6,'#5a3a1a'],[0,2,1,3,'#b8c0c8'],                       // machado esquerdo
    [12,2,1,6,'#5a3a1a'],[13,2,1,3,'#b8c0c8'],                     // machado direito
    [4,9,2,4,'#3a2a18'],[8,9,2,4,'#3a2a18'],                       // pernas afastadas
    [3,13,3,1,'#1c1c1c'],[8,13,3,1,'#1c1c1c'],                     // botas
    [4,4,6,5,'#3f7a2a'],[5,5,1,3,'#c0272d'],[8,5,1,3,'#c0272d'],[4,8,6,1,'#3a2a18'], // torso, pinturas, arreio
    [2,3,2,3,'#3f7a2a'],[10,3,2,3,'#3f7a2a'],                      // braços erguidos
    [4,1,6,3,'#3f7a2a'],[6,0,2,1,'#1a1a1f'],                       // cabeça, crista
    [5,2,1,1,'#ffd84d'],[8,2,1,1,'#ffd84d'],[5,3,1,1,'#f2ecd0'],[8,3,1,1,'#f2ecd0'] // olhos, presas
  ],
  ORC_MOB_005: [ // Xamã das Cinzas
    [12,2,1,11,'#5a3a1a'],[11,0,3,2,'#b97bff'],                    // cajado e orbe
    [4,4,6,8,'#6b3fa0'],[4,7,6,1,'#c9a227'],[4,11,6,1,'#4a2870'],[6,5,2,1,'#f2ecd0'], // manto, faixa, barra, talismã
    [2,5,2,4,'#55318a'],[10,5,2,4,'#55318a'],                      // mangas
    [2,9,1,1,'#4f9a35'],[11,9,1,1,'#4f9a35'],                      // mãos
    [5,12,2,1,'#2a1a0a'],[7,12,2,1,'#2a1a0a'],                     // pés
    [3,2,1,1,'#6abf45'],[10,2,1,1,'#6abf45'],                      // orelhas
    [4,1,6,3,'#4f9a35'],[5,0,1,2,'#e8e0c8'],[8,0,1,2,'#e8e0c8'],   // cabeça, ossos
    [5,2,1,1,'#ffd84d'],[8,2,1,1,'#ffd84d']                        // olhos
  ],
  ORC_MOB_006: [ // Troll Quebra-ossos
    [13,3,1,8,'#5a3a1a'],[12,1,2,3,'#9aa0a8'],                     // martelo de pedra
    [4,10,2,3,'#6f8397'],[8,10,2,3,'#6f8397'],                     // pernas
    [3,13,3,1,'#5c6e82'],[8,13,3,1,'#5c6e82'],                     // pés
    [1,4,2,7,'#7d8fa3'],[11,4,2,7,'#7d8fa3'],                      // braços longos
    [1,10,2,2,'#6a7d91'],[11,10,2,2,'#6a7d91'],                    // punhos
    [3,3,8,6,'#8aa0b5'],[4,6,6,2,'#6f8397'],[4,9,6,1,'#5a4630'],   // tronco largo, barriga, tanga
    [5,0,4,3,'#7d8fa3'],[5,3,4,1,'#66788c'],                       // cabeça, mandíbula
    [6,1,1,1,'#ffd84d'],[8,1,1,1,'#ffd84d']                        // olhos
  ],
  ORC_BOSS_001: [ // Ghorak, Campeão da Horda (grade 20×20; machado já incluso)
    [18,3,1,15,'#4a3320'],[17,1,3,5,'#b8c0c8'],[19,2,1,3,'#e8eef4'], // machado de duas mãos
    [7,17,2,2,'#1a1a1f'],[11,17,2,2,'#1a1a1f'],                    // pernas
    [6,19,3,1,'#0e0e12'],[11,19,3,1,'#0e0e12'],                    // botas
    [2,10,4,5,'#7a2222'],[14,10,4,5,'#7a2222'],                    // braços
    [6,7,8,8,'#1a1a1f'],[9,9,2,3,'#c0272d'],[6,14,8,1,'#c0272d'],[7,15,6,2,'#2a2a30'], // torso, runa, cinto, saiote
    [1,7,5,3,'#1a1a1f'],[2,5,1,2,'#c0272d'],[4,5,1,2,'#c0272d'],   // ombreira grande + espinhos
    [14,7,4,2,'#2a2a30'],                                          // ombreira menor (assimétrica)
    [6,3,8,4,'#7a2222'],[5,1,10,2,'#1a1a1f'],                      // cabeça, elmo
    [4,0,2,3,'#e8e0c8'],[14,0,2,3,'#e8e0c8'],                      // chifres
    [7,4,2,1,'#ffd35c'],[11,4,2,1,'#ffd35c'],[7,6,1,2,'#f2ecd0'],[12,6,1,2,'#f2ecd0'] // olhos, presas
  ]
};
// Nome exibido (sem "Elite "/"Semi-Boss ") → ID do bestiário
const PLACEHOLDER_NAME_TO_ID = {
  'Goblin Saqueador': 'ORC_MOB_001', 'Goblin': 'ORC_MOB_001',
  'Guerreiro da Horda': 'ORC_MOB_002', 'Guerreiro Orc': 'ORC_MOB_002',
  'Caçador da Horda': 'ORC_MOB_003',
  'Berserker Sangrento': 'ORC_MOB_004',
  'Xamã das Cinzas': 'ORC_MOB_005', 'Xamã Orc': 'ORC_MOB_005',
  'Troll Quebra-ossos': 'ORC_MOB_006', 'Troll': 'ORC_MOB_006',
  'Ghorak': 'ORC_BOSS_001'
};
Object.assign(PLACEHOLDER_SPRITES, {
  ORC_MOB_007: [ // Guardião do Escudo Negro
    [5,10,2,3,'#1d3a1b'],[7,10,2,3,'#1d3a1b'],                     // pernas
    [4,13,3,1,'#111111'],[7,13,3,1,'#111111'],                     // botas
    [4,5,6,5,'#2a2d33'],                                           // torso
    [10,6,2,3,'#2f6b2a'],[10,5,2,1,'#3a3d44'],                     // braço e ombreira
    [4,1,6,2,'#3a3d44'],[5,3,4,2,'#2f6b2a'],                       // elmo e rosto
    [5,3,1,1,'#ff4040'],[8,3,1,1,'#ff4040'],[5,4,1,1,'#f2ecd0'],[8,4,1,1,'#f2ecd0'], // olhos, presas
    [1,4,4,7,'#1c1d22'],[1,4,4,1,'#5a5f66'],[1,10,4,1,'#5a5f66'],[2,7,2,1,'#7b828c'] // escudo retangular
  ],
  ORC_MOB_008: [ // Javali de Guerra
    [2,11,1,2,'#3a2a22'],[4,11,1,2,'#3a2a22'],[9,11,1,2,'#3a2a22'],[11,11,1,2,'#3a2a22'], // patas
    [2,13,1,1,'#111111'],[4,13,1,1,'#111111'],[9,13,1,1,'#111111'],[11,13,1,1,'#111111'], // cascos
    [12,7,1,2,'#2a1c16'],                                          // cauda
    [3,6,9,5,'#4a3328'],[4,5,7,1,'#2a1c16'],                       // corpo e cerdas
    [6,6,1,5,'#7b828c'],[9,6,1,5,'#7b828c'],[7,6,2,2,'#5a5f66'],   // arreios metálicos
    [0,6,4,4,'#3a2a22'],[0,8,2,2,'#5a4034'],[3,5,1,1,'#2a1c16'],   // cabeça, focinho, orelha
    [0,9,1,2,'#f2ecd0'],[2,10,1,1,'#f2ecd0'],[2,7,1,1,'#ff4040']   // presas e olho
  ],
  ORC_MOB_009: [ // Carrasco da Fortaleza
    [4,11,2,2,'#2a2d33'],[8,11,2,2,'#2a2d33'],                     // pernas
    [4,13,2,1,'#111111'],[8,13,2,1,'#111111'],                     // botas
    [1,7,2,4,'#34373d'],[11,7,2,4,'#34373d'],[1,11,2,1,'#1d1d20'],[11,11,2,1,'#1d1d20'], // braços e manoplas
    [4,4,6,6,'#3f434a'],[5,5,4,1,'#7b828c'],[4,9,6,1,'#1d1d20'],[5,10,4,2,'#2a2d33'],[9,10,1,2,'#7a2222'], // placas, cinto, avental
    [1,4,3,3,'#4a4f57'],[10,4,3,3,'#4a4f57'],[1,3,1,1,'#7b828c'],[12,3,1,1,'#7b828c'], // ombreiras e espinhos
    [4,0,6,4,'#34373d'],[5,2,4,1,'#c0272d']                        // elmo fechado e fresta
  ],
  ORC_BOSS_002: [ // Dravok, Senhor da Guerra (grade 20×20; martelo de guerra incluso)
    [17,5,1,13,'#4a3320'],[15,1,5,4,'#5a5f66'],[16,2,3,1,'#9aa0a8'],[19,3,1,2,'#ff8a2a'], // martelo de guerra
    [6,15,3,3,'#2a2d33'],[11,15,3,3,'#2a2d33'],                    // pernas
    [5,18,4,2,'#111111'],[11,18,4,2,'#111111'],                    // botas
    [2,10,3,4,'#2f6b2a'],[13,10,4,4,'#2f6b2a'],                    // braços
    [5,7,10,8,'#2d3036'],[5,7,10,1,'#d9a62e'],[9,9,2,3,'#ff7a1a'],[5,13,10,1,'#d9a62e'],[7,14,6,3,'#8a2e1a'], // torso cerimonial, brasão, tabardo
    [1,6,5,3,'#3a3d44'],[1,4,1,2,'#d9a62e'],[3,4,1,2,'#d9a62e'],[5,5,1,1,'#d9a62e'], // ombreira pontiaguda esquerda
    [13,6,4,3,'#3a3d44'],[13,4,1,2,'#d9a62e'],[15,5,1,1,'#d9a62e'], // ombreira direita
    [6,1,8,3,'#3a3d44'],[9,0,2,1,'#d9a62e'],[5,0,1,2,'#d9a62e'],[14,0,1,2,'#d9a62e'], // elmo e pontas
    [6,4,8,3,'#2f6b2a'],[7,4,2,1,'#ffb02e'],[11,4,2,1,'#ffb02e'],[7,6,1,2,'#f2ecd0'],[12,6,1,2,'#f2ecd0'] // rosto, olhos, presas
  ]
});
Object.assign(PLACEHOLDER_NAME_TO_ID, {
  'Guardião do Escudo Negro': 'ORC_MOB_007',
  'Javali de Guerra': 'ORC_MOB_008',
  'Carrasco da Fortaleza': 'ORC_MOB_009',
  'Dravok': 'ORC_BOSS_002'
});
const BOSS_WEAPON = [[5,8,2,30,'#a08a5a'],[2,1,8,8,'#7a1f1f'],[3,2,6,6,'#ff5a5a'],[4,3,1,1,'#ffe3e3'],[3,2,1,6,'#d5ad58'],[8,2,1,6,'#d5ad58']];
const weaponG = (a, cls = '') => `<g${cls ? ` class="${cls}"` : ''} transform="scale(.5)">${rects(a)}</g>`;
const heroSvg = c => `<svg class="spr" viewBox="0 0 11 13" style="width:calc(var(--hero-sprite-w,40px)*var(--hs,1));height:calc(var(--hero-sprite-h,48px)*var(--hs,1))">${rects(SPRITES[c])}${weaponG(WEAPONS[c], c === 'warrior' ? 'sword' : '')}</svg>`;
const heroBig = c => `<svg class="spr" viewBox="0 0 11 13">${rects(SPRITES[c])}${weaponG(WEAPONS[c], c === 'warrior' ? 'sword' : '')}</svg>`;
const HICON = {
  warrior: `<img class="skill-icon" src="assets/hicon-warrior.png" alt="Power Strike">`,
  archer: `<img class="skill-icon" src="assets/hicon-archer.png" alt="Aimed Shot">`,
  mage: `<img class="skill-icon" src="assets/hicon-mage.png" alt="Fireball">`
};
const HERO_PORTRAITS = { warrior: "assets/portrait-warrior.webp", archer: "assets/portrait-archer.webp", mage: "assets/portrait-mage.webp" };
const WARRIOR_FULLBODY_PANEL = 'assets/fullbody-warrior.jpg';
const ARCHER_FULLBODY_PANEL = 'assets/fullbody-archer.jpg';
const MAGE_FULLBODY_PANEL = 'assets/fullbody-mage.jpg';
function heroPortrait(classId, extraClass='') {
  const key = HERO_PORTRAITS[classId] ? classId : 'warrior';
  const label = ({warrior:'Guerreiro',archer:'Arqueira',mage:'Mago'})[key];
  return `<img class="hero-portrait ${extraClass}" src="${HERO_PORTRAITS[key]}" alt="Retrato: ${label}" loading="eager" draggable="false">`;
}

function hue(s){ let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
function enemySvg(e) {
  const baseName = e.name.replace(/^(Elite|Semi-Boss) /, '');
  const phId = PLACEHOLDER_NAME_TO_ID[baseName] || PLACEHOLDER_NAME_TO_ID[baseName.split(',')[0].trim()];

  if (phId && phId.includes('BOSS')) return `<svg class="spr spr-boss" viewBox="0 0 20 20"><g>${rects(PLACEHOLDER_SPRITES[phId])}</g></svg>`; // arma já está no desenho
  if (phId) return `<svg class="spr" viewBox="0 0 14 14" style="width:var(--combat-unit-size,56px);height:var(--combat-unit-size,56px)">${rects(PLACEHOLDER_SPRITES[phId])}</svg>`;

  if (e.isBoss) return `<svg class="spr spr-boss" viewBox="0 0 20 20"><g>${rects([[4,2,12,7,'#c74443'],[2,4,2,5,'#a83838'],[16,4,2,5,'#a83838'],[6,9,8,8,'#8a2e2e'],[3,10,3,6,'#6e2424'],[14,10,3,6,'#6e2424'],[8,4,1,1,'#ffd35c'],[11,4,1,1,'#ffd35c'],[9,10,2,2,'#ffd35c']])}</g>${weaponG(BOSS_WEAPON)}</svg>`;

  const h = hue(e.name.replace('Elite ', '')), c1 = `hsl(${h},32%,26%)`, c2 = `hsl(${h},32%,36%)`;
  return `<svg class="spr" viewBox="0 0 14 14" style="width:var(--combat-unit-size,56px);height:var(--combat-unit-size,56px)">${rects([[4,1,6,5,c1],[4,6,6,6,c2],[2,7,2,4,c1],[10,7,2,4,c1],[5,3,1,1,'#c74443'],[8,3,1,1,'#c74443']])}${ENEMY_WEAPONS[ENEMY_WEAPON_BY_NAME[e.name.replace(/^(Elite|Semi-Boss) /, '')]] ? weaponG(ENEMY_WEAPONS[ENEMY_WEAPON_BY_NAME[e.name.replace(/^(Elite|Semi-Boss) /, '')]]) : ''}</svg>`;
}

const HPOS = [{l:18,t:75,s:1.32,z:3},{l:32,t:60,s:1.2,z:2},{l:18,t:45,s:1.08,z:1}];
const EPOS = {l:82, t:60, tb:45};
const GROUP_EPOS = [{l:82,t:75},{l:68,t:60},{l:82,t:45}];

function renderAuto() { const b = $('autoBtn'); if(b) { b.textContent = GameRefs.autoBattle ? 'AUTO' : 'MANUAL'; b.classList.toggle('on', GameRefs.autoBattle); } }
function renderPause() { const b = $('pauseBtn'); if (!b) return; b.textContent = GameRefs.combatPaused ? '▶ RETOMAR' : '⏸ PAUSAR'; b.classList.toggle('on', GameRefs.combatPaused); }
function toast(msg, cls) {
  const t = document.createElement('div'); t.className = 'toast ' + (cls || ''); t.textContent = msg;
  $('toasts').appendChild(t); while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  setTimeout(() => t.remove(), 2600);
}
Logger._write = function(msg) {
  UI.feed.push(msg); if (UI.feed.length > 3) UI.feed.shift();
  const f = $('feed'); if (f) f.innerHTML = UI.feed.map(m => `<div>${m}</div>`).join('');
};
function showOv(html, bad) { clearFireworks(); $('ov').classList.remove('menu-home'); $('ovb').className = 'ovb' + (bad ? ' bad' : ''); $('ovb').innerHTML = html; $('ov').classList.add('on'); }
function hideOv() { $('ov').classList.remove('on'); clearFireworks(); }

const CEL_THEME = { 2: { bursts: 5, cols: ['#3fd9e8', '#9ff3ff', '#ffffff', '#7ab8ff'] }, 3: { bursts: 8, cols: ['#ffd35c', '#ff8a3d', '#ff5a5a', '#ffffff', '#c9a0ff'] } };
UI.fxTimers = [];
function clearFireworks() {
  UI.fxTimers.forEach(id => clearTimeout(id)); UI.fxTimers = [];
  const l = $('fxLayer'); if (l) l.innerHTML = ''; const b = $('ovb'); if (b) b.classList.remove('celebrate');
}
function launchFireworks(th, rank) {
  const l = $('fxLayer'); if (!l) return;
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches), n = reduce ? 1 : th.bursts, per = reduce ? 10 : 18;
  l.dataset.rank = rank; l.innerHTML = '<div class="glow"></div>' + (reduce ? '' : '<div class="rays"></div>');
  for (let b = 0; b < n; b++) {
    UI.fxTimers.push(setTimeout(() => {
      const x = 12 + Math.random() * 76, y = 12 + Math.random() * 46, nodes = [];
      const mk = (cls, css) => { const p = document.createElement('i'); p.className = cls; p.style.cssText = css; l.appendChild(p); nodes.push(p); };
      mk('fwf', `left:${x}%;top:${y}%;--c:${th.cols[b % th.cols.length]}`);
      for (let k = 0; k < per; k++) { const a = (k / per) * Math.PI * 2 + Math.random() * .3, d = 55 + Math.random() * 55; mk('fw', `left:${x}%;top:${y}%;--c:${th.cols[(b + k) % th.cols.length]};--dx:${Math.round(Math.cos(a) * d)}px;--dy:${Math.round(Math.sin(a) * d)}px`); }
      UI.fxTimers.push(setTimeout(() => nodes.forEach(nd => nd.remove()), 1400));
    }, 250 + b * 420));
  }
}
function showEvolutionCelebration(item, fromStage) {
  const to = Math.min(3, Math.max(2, weaponStage(item))), th = CEL_THEME[to], N = WEAPON_RANK_NAMES;
  showOv(`<h2 class="d">✨ EVOLUÇÃO! ✨</h2><div class="cel-ic">${item.slot === 'armor' ? '🛡' : '🗡'}</div><div class="d" style="font-size:16px">${item.name}</div>
    <div style="margin:10px 0"><span class="rk rk${fromStage}">Rank ${N[fromStage - 1]}</span> <b style="color:var(--gold)">➜</b> <span class="rk rk${to}">${'★'.repeat(to - 1)} Rank ${N[to - 1]}</span></div>
    <div class="dim">Nível 1/${weaponMaxLevel(item)} · raridade preservada</div>
    <button class="btn pri" data-act="closeOv" style="width:100%;padding:11px;margin-top:14px">Continuar</button>`);
  const b = $('ovb'); b.classList.add('celebrate'); b.dataset.rank = to; launchFireworks(th, to);
}

(function hooks() {
  let lastCrit = false;
  const cd = DamageSystem.computeDamage.bind(DamageSystem);
  DamageSystem.computeDamage = function(s) { const r = cd(s); lastCrit = r.isCrit; return r; };
  const dd = StatusEffectService.dealDamage.bind(StatusEffectService);
  StatusEffectService.dealDamage = function(target, amount) {
    const before = target.currentHP;
    dd(target, amount);
    const lost = Math.round(before - target.currentHP), crit = lastCrit; lastCrit = false;
    if (G && UI.screen === 'abyss') UI.onDamage(target, lost, crit);
  };
  const ph = AutoCombatController.prototype._performHit;
  AutoCombatController.prototype._performHit = function(hero, enemy) {
    if (hero.classId === 'warrior') {
      const unit = UI.refs[hero.instanceId]?.el;
      if (unit) { unit.classList.remove('swing'); void unit.offsetWidth; unit.classList.add('swing'); setTimeout(() => unit.classList.remove('swing'), 260); }
    }
    UI.attackFx(hero, enemy);
    return ph.call(this, hero, enemy);
  };
  const cs = SkillSystem.prototype.castSkill;
  SkillSystem.prototype.castSkill = function(hero) {
    const target = selectLivingEnemy(this.encounter);
    const ready = this.canCast(hero) && !!target;
    if (ready && hero.classId === 'warrior') showPowerStrikeVfx(target);
    if (ready && hero.classId === 'archer') showAimedShotVfx(hero, target);
    if (ready && hero.classId === 'mage') showFireballVfx(target);
    if (ready) UI.attackFx(hero, target, 260);
    return cs.call(this, hero);
  };
})();

UI.flag = (key, cls, ms) => { const u = UI.refs[key]; if (!u) return; u.el.classList.add(cls); setTimeout(() => u.el.classList.remove(cls), ms); };
const POWER_STRIKE_GIF = "assets/ui-power-strike.gif";
const AIMED_SHOT_GIF = "assets/ui-aimed-shot.gif";
const FIREBALL_EXPLOSION_GIF = "assets/ui-fireball-explosion.gif";

function triggerSkillImpact(xPct = 65, yPct = 48, shake = true, enemy = false) {
  const arena = document.getElementById('arena');
  if (!arena || UI.screen !== 'abyss') return;
  const flash = document.createElement('div');
  flash.className = 'skill-flash' + (enemy ? ' enemy-skill-flash' : '');
  flash.style.setProperty('--fx-x', xPct + '%');
  flash.style.setProperty('--fx-y', yPct + '%');
  arena.appendChild(flash);
  setTimeout(() => flash.remove(), 380);
  if (shake) {
    arena.classList.remove('shake'); void arena.offsetWidth;
    arena.classList.add('shake');
    setTimeout(() => arena.classList.remove('shake'), 300);
  }
}
function showAimedShotVfx(hero, target) {
  const arena = document.getElementById('arena');
  const heroUnit = hero && UI.refs[hero.instanceId];
  const targetUnit = target && UI.refs['enemy-' + target.id];
  if (!arena || !heroUnit || !targetUnit || UI.screen !== 'abyss') return;
  const pos = (unit) => {
    const c = centerOf(unit);
    return { x: c.cx / Math.max(1, arena.clientWidth) * 100, y: c.cy / Math.max(1, arena.clientHeight) * 100 };
  };
  const from = pos(heroUnit), to = pos(targetUnit);

  const projectile = document.createElement('div');
  projectile.className = 'proj arrow aimed-shot-projectile';
  projectile.innerHTML = PROJ.arrow[0];
  projectile.style.position = 'absolute';
  projectile.style.left = from.x + '%'; projectile.style.top = from.y + '%';
  projectile.style.zIndex = '24';
  projectile.style.filter = 'drop-shadow(0 0 7px rgba(80,145,255,.95)) drop-shadow(0 0 14px rgba(95,170,255,.8))';
  projectile.style.transform = 'translate(-50%,-50%)';
  arena.appendChild(projectile);
  void projectile.offsetWidth;
  const dx = (to.x - from.x) / 100 * arena.clientWidth;
  const dy = (to.y - from.y) / 100 * arena.clientHeight;
  const duration = Math.max(220, Math.min(480, Math.hypot(dx, dy) / 1.1));
  projectile.style.transition = `left ${duration}ms linear, top ${duration}ms linear, filter ${duration}ms linear`;
  projectile.style.left = to.x + '%'; projectile.style.top = to.y + '%';
  setTimeout(() => {
    projectile.remove();
    if (UI.screen !== 'abyss' || !document.getElementById('arena')) return;
    [0, 220, 440].forEach((delay) => setTimeout(() => {
      if (UI.screen !== 'abyss') return;
      const fx = document.createElement('img');
      fx.className = 'skill-vfx aimed-shot-vfx'; fx.alt = ''; fx.src = AIMED_SHOT_GIF;
      fx.style.width = 'clamp(135px, 27.8vw, 210px)'; fx.style.left = to.x + '%'; fx.style.top = to.y + '%';
      fx.style.filter = 'drop-shadow(0 0 14px rgba(80,145,255,1)) drop-shadow(0 0 28px rgba(95,170,255,.9))';
      arena.appendChild(fx); triggerSkillImpact(to.x, to.y, true); setTimeout(() => fx.remove(), 1600);
    }, delay));
  }, duration);
}
function showFireballVfx(target) {
  const arena = document.getElementById('arena'), targetUnit = target && UI.refs[target.id];
  if (!arena || UI.screen !== 'abyss') return;
  let x = 65, y = 48;
  if (targetUnit && targetUnit.el) {
    const c = centerOf(targetUnit); x = c.cx / Math.max(1, arena.clientWidth) * 100; y = c.cy / Math.max(1, arena.clientHeight) * 100;
  }
  triggerSkillImpact(x, y, true);
  const offsets = [{x:-5,y:1,delay:0},{x:4,y:-3,delay:170},{x:0,y:4,delay:340}];
  offsets.forEach((o, i) => setTimeout(() => {
    if (!document.getElementById('arena') || UI.screen !== 'abyss') return;
    const fx = document.createElement('img');
    fx.className = 'skill-vfx fireball-vfx'; fx.alt = ''; fx.src = FIREBALL_EXPLOSION_GIF;
    fx.style.width = 'clamp(132px, 29vw, 224px)';
    fx.style.filter = 'drop-shadow(0 0 14px rgba(255,115,35,.98)) drop-shadow(0 0 25px rgba(255,190,65,.65))';
    fx.style.left = Math.max(8, Math.min(92, x + o.x)) + '%'; fx.style.top = Math.max(12, Math.min(88, y + o.y)) + '%';
    fx.style.animationDelay = '0ms'; arena.appendChild(fx); setTimeout(() => fx.remove(), 1600);
  }, o.delay));
}
function showPowerStrikeVfx(target) {
  const arena = document.getElementById('arena'), targetUnit = target && UI.refs[target.id];
  if (!arena || UI.screen !== 'abyss') return;
  const fx = document.createElement('img');
  fx.className = 'skill-vfx'; fx.alt = ''; fx.src = POWER_STRIKE_GIF;
  fx.style.filter = 'drop-shadow(0 0 13px rgba(255,190,45,.98)) drop-shadow(0 0 24px rgba(255,90,25,.7))';
  if (targetUnit && targetUnit.el) {
    const c = centerOf(targetUnit); fx.style.left = (c.cx / Math.max(1, arena.clientWidth) * 100) + '%'; fx.style.top = (c.cy / Math.max(1, arena.clientHeight) * 100) + '%';
  } else { fx.style.left = '65%'; fx.style.top = '48%'; }
  triggerSkillImpact(parseFloat(fx.style.left), parseFloat(fx.style.top), true);
  arena.appendChild(fx); setTimeout(() => fx.remove(), 1250);
}
function centerOf(u) {
  const r = u.el, centeredX = u.base && u.base.indexOf('translateX(-50%)') >= 0;
  return { cx: r.offsetLeft + (centeredX ? 0 : r.offsetWidth / 2), cy: r.offsetTop + r.offsetHeight / 2 };
}
const MOVE_DUST_GIF = "assets/move-dust.webp";
UI.moveDustFx = (key) => {
  const u = UI.refs[key], layer = $('units');
  if (!u || !u.el || !layer || UI.screen !== 'abyss' || layer.querySelectorAll('.move-dust-fx').length > 16) return;
  const el = u.el, isEnemy = key.startsWith('enemy-'), ux = el.offsetLeft + el.offsetWidth / 2;
  let opponent = null, best = Infinity;
  Object.keys(UI.refs || {}).forEach(k => {
    if (k === key || k.startsWith('enemy-') === isEnemy) return;
    const v = UI.refs[k]; if (!v || !v.el || !v.el.isConnected) return;
    const vx = v.el.offsetLeft + v.el.offsetWidth / 2, vy = v.el.offsetTop + v.el.offsetHeight * 0.46, uy = el.offsetTop + el.offsetHeight * 0.46;
    const d = Math.hypot(vx - ux, vy - uy);
    if (d < best) { best = d; opponent = v; }
  });
  const toward = opponent ? Math.sign((opponent.el.offsetLeft + opponent.el.offsetWidth / 2) - ux) : (isEnemy ? -1 : 1);
  const back = -toward;
  const dust = document.createElement('img');
  dust.className = 'move-dust-fx'; dust.alt = ''; dust.src = MOVE_DUST_GIF;
  dust.style.left = (ux + back * Math.max(12, el.offsetWidth * 0.24)) + 'px'; dust.style.top = (el.offsetTop + el.offsetHeight - 2) + 'px';
  dust.style.setProperty('--dust-dx', (back * 12) + 'px'); dust.style.setProperty('--dust-dx-mid', (back * 22) + 'px'); dust.style.setProperty('--dust-dx-end', (back * 34) + 'px');
  layer.insertBefore(dust, layer.firstChild); setTimeout(() => dust.remove(), 600);
};
UI.lunge = (key, targetKey, ms) => {
  const u = UI.refs[key], t = UI.refs[targetKey];
  if (!u || !t || UI.screen !== 'abyss') return;
  UI.moveDustFx(key);
  const dur = ms || 150, a = centerOf(u), b = centerOf(t), dx = (b.cx - a.cx) * 0.55, dy = (b.cy - a.cy) * 0.55;
  const base = u.base ? u.base + ' ' : '';
  u.el.style.transition = `transform ${Math.round(dur * 0.55)}ms ease-out`;
  u.el.style.transform = `${base}translate(${dx}px, ${dy}px)`;
  clearTimeout(u.lungeTimer);
  u.lungeTimer = setTimeout(() => {
    u.el.style.transition = `transform ${Math.round(dur * 0.8)}ms ease-in`; u.el.style.transform = `${base}translate(0,0)`; UI.moveDustFx(key);
  }, dur);
};
const PROJ = { arrow: ['<svg class="spr" viewBox="0 0 12 3" width="24" height="6">' + rects([[0,1,9,1,'#c9b48a'],[9,0,1,3,'#e8eef5'],[10,1,2,1,'#e8eef5'],[0,0,2,1,'#c74443'],[0,2,2,1,'#c74443']]) + '</svg>', 12, 3], bolt:  ['<svg class="spr" viewBox="0 0 7 7" width="28" height="28">' + rects([[2,0,3,7,'#45eaff'],[0,2,7,3,'#45eaff'],[1,1,5,5,'#8cffff'],[2,2,3,3,'#e4ffff'],[3,3,1,1,'#ffffff']]) + '</svg>', 14, 14] };
UI.projCount = 0;
UI.shoot = (kind, key, targetKey) => {
  const u = UI.refs[key], t = UI.refs[targetKey], layer = $('floats');
  if (!u || !t || !layer || UI.screen !== 'abyss' || UI.projCount >= 12) return;
  const a = centerOf(u), b = centerOf(t), sx = a.cx + 14, sy = a.cy - 6;
  const dx = b.cx - sx, dy = b.cy - sy, ang = Math.atan2(dy, dx) * 180 / Math.PI, dur = Math.round(Math.max(180, Math.min(450, Math.hypot(dx, dy) / 0.9)));
  const p = document.createElement('div'); p.className = 'proj ' + kind; p.innerHTML = PROJ[kind][0]; p.dataset.target = targetKey;
  p.style.left = (sx - PROJ[kind][1]) + 'px'; p.style.top = (sy - PROJ[kind][2]) + 'px';
  p.style.transform = `translate(0px, 0px) rotate(${ang}deg)`; layer.appendChild(p); void p.offsetWidth;
  p.style.transition = `transform ${dur}ms linear`; p.style.transform = `translate(${dx}px, ${dy}px) rotate(${ang}deg)`;
  UI.projCount++;
  setTimeout(() => { if (kind === 'bolt') UI.mageBasicBurst(targetKey); p.remove(); UI.projCount--; }, dur);
};
const BASIC_HIT_IMPACT_GIF = "assets/basic-hit-impact.webp";
UI.meleeImpactFx = (targetKey) => {
  const target = UI.refs[targetKey], layer = $('floats');
  if (!target || !target.el || !layer || UI.screen !== 'abyss' || layer.children.length > 36) return;
  const targetEl = target.el, centerX = targetEl.offsetLeft + targetEl.offsetWidth * 0.5, ty = targetEl.offsetTop + targetEl.offsetHeight * 0.46, tx = centerX, targetIsEnemy = targetKey.startsWith('enemy-');
  let attacker = null, best = Infinity;
  Object.keys(UI.refs || {}).forEach(k => {
    if (k === targetKey) return; const candidate = UI.refs[k];
    if (!candidate || !candidate.el || !candidate.el.isConnected) return;
    if (k.startsWith('enemy-') === targetIsEnemy) return;
    const el = candidate.el, cx = el.offsetLeft + el.offsetWidth * 0.5, cy = el.offsetTop + el.offsetHeight * 0.46;
    if ((targetIsEnemy && cx >= tx) || (!targetIsEnemy && cx <= tx)) return;
    const d = Math.hypot(cx - tx, cy - ty); if (d < best) { best = d; attacker = candidate; }
  });
  const ax = attacker ? attacker.el.offsetLeft + attacker.el.offsetWidth * 0.5 : (targetIsEnemy ? tx - 30 : tx + 30);
  const ay = attacker ? attacker.el.offsetTop + attacker.el.offsetHeight * 0.46 : ty;
  const facingSide = Math.sign(ax - centerX) || (targetIsEnemy ? -1 : 1);
  const impactX = centerX + facingSide * targetEl.offsetWidth * 0.24, angle = Math.atan2(ty - ay, tx - ax) * 180 / Math.PI;
  const impact = document.createElement('img');
  impact.className = 'basic-hit-impact'; impact.alt = ''; impact.src = BASIC_HIT_IMPACT_GIF;
  impact.style.left = impactX + 'px'; impact.style.top = ty + 'px';
  impact.style.setProperty('--slash-angle', angle + 'deg'); impact.style.transform = `translate(-50%,-50%) rotate(${angle}deg)`;
  layer.appendChild(impact); setTimeout(() => impact.remove(), 520);
};
UI.mageBasicBurst = (targetKey) => {
  const target = UI.refs[targetKey], layer = $('floats');
  if (!target || !target.el || !layer || UI.screen !== 'abyss' || layer.children.length > 36) return;
  const burst = document.createElement('div'); burst.className = 'mage-basic-burst'; burst.setAttribute('aria-hidden', 'true');
  burst.style.left = (target.el.offsetLeft + target.el.offsetWidth * 0.5) + 'px'; burst.style.top = (target.el.offsetTop + target.el.offsetHeight * 0.46) + 'px';
  layer.appendChild(burst); setTimeout(() => burst.remove(), 390);
};
UI.attackFx = (hero, enemy, ms) => {
  const kind = hero.classId === 'archer' ? 'arrow' : hero.classId === 'mage' ? 'bolt' : null;
  if (kind) UI.shoot(kind, hero.instanceId, 'enemy-' + enemy.id); else UI.lunge(hero.instanceId, 'enemy-' + enemy.id, ms);
};
function showBossDefeatVfx(enemy, unit) {
  const layer = $('units');
  if (!layer || !enemy || !unit || !enemy.isBoss || enemy._bossDefeatVfxShown || UI.screen !== 'abyss') return;
  enemy._bossDefeatVfxShown = true; const c = centerOf(unit), fx = document.createElement('div');
  fx.className = 'boss-death-vfx'; fx.style.left = c.cx + 'px'; fx.style.top = c.cy + 'px';
  const flash = document.createElement('div'); flash.className = 'boss-death-flash'; fx.appendChild(flash);
  const ring = document.createElement('div'); ring.className = 'boss-death-ring'; fx.appendChild(ring);
  const colors = ['#ffffff','#fff4b5','#a8edff','#c7b5ff','#ffe29a'];
  for (let i = 0; i < 24; i++) {
    const p = document.createElement('i'); p.className = 'boss-death-particle';
    const angle = (Math.PI * 2 * i / 24) + (Math.random() - .5) * .32, distance = 48 + Math.random() * 92;
    p.style.setProperty('--dx', (Math.cos(angle) * distance) + 'px'); p.style.setProperty('--dy', (Math.sin(angle) * distance) + 'px');
    p.style.setProperty('--size', (3 + Math.random() * 5) + 'px'); p.style.setProperty('--dur', (.72 + Math.random() * .48) + 's');
    p.style.setProperty('--delay', (Math.random() * .13) + 's'); p.style.setProperty('--particle-color', colors[Math.floor(Math.random() * colors.length)]);
    fx.appendChild(p);
  }
  const crystal = document.createElement('div'); crystal.className = 'boss-crystal';
  crystal.innerHTML = '<svg viewBox="0 0 48 64" aria-hidden="true"><defs><linearGradient id="bossCrystalMain" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".34" stop-color="#a9f4ff"/><stop offset=".68" stop-color="#70a8ff"/><stop offset="1" stop-color="#e7c8ff"/></linearGradient><linearGradient id="bossCrystalSide" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6c8fff"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><path d="M24 2 43 19 36 48 24 62 11 48 5 19Z" fill="url(#bossCrystalMain)" stroke="#ffffff" stroke-width="1.7"/><path d="M24 2 24 62 11 48 5 19Z" fill="#a4eaff" opacity=".72"/><path d="M24 2 43 19 36 48 24 62Z" fill="url(#bossCrystalSide)" opacity=".72"/><path d="M24 2 18 22 24 38 30 22Z" fill="#ffffff" opacity=".9"/><path d="M5 19 18 22 24 38 11 48Z" fill="#d8fbff" opacity=".7"/><path d="M43 19 30 22 24 38 36 48Z" fill="#8b9dff" opacity=".8"/><path d="M18 22 30 22 24 38Z" fill="#ffffff" opacity=".75"/></svg>';
  fx.appendChild(crystal); layer.appendChild(fx); setTimeout(() => fx.remove(), 3450);
}
UI.onDamage = (target, lost, crit, raw) => {
  const isHero = !!target.instanceId, key = isHero ? target.instanceId : 'enemy-' + target.id, u = UI.refs[key];
  if (!u || UI.screen !== 'abyss') return;
  if (!isHero && lost > 0 && target.currentHP <= 0 && target.isBoss) showBossDefeatVfx(target, u);
  if (lost > 0 && target.currentHP <= 0) {
    const f = document.createElement('div'); f.className = 'fl'; f.textContent = isHero ? '💀' : '☠';
    f.style.left = (u.el.offsetLeft + 4) + 'px'; f.style.top = (u.el.offsetTop - 10) + 'px'; f.style.fontSize = '22px';
    $('floats').appendChild(f); setTimeout(() => f.remove(), 1000);
  }
  if (lost > 0) UI.meleeImpactFx(key);
  const arena = $('arena');
  if (crit) {
    u.el.classList.remove('crit-hit'); void u.el.offsetWidth; u.el.classList.add('crit-hit'); setTimeout(() => u.el.classList.remove('crit-hit'), 280);
    arena.classList.remove('shake'); void arena.offsetWidth; arena.classList.add('shake'); setTimeout(() => arena.classList.remove('shake'), 280);
  } else { u.el.classList.add('hit'); setTimeout(() => u.el.classList.remove('hit'), 90); }
  const floats = $('floats');
  if (floats && floats.children.length < 28) {
    const f = document.createElement('div'); f.className = 'fl' + (crit ? ' crit' : '') + (isHero ? ' hero' : '');
    f.textContent = lost > 0 ? (crit ? '★' + lost + '!' : String(lost)) : '🛡';
    const scatter = Math.random() * 34 - 8;
    f.style.left = (u.el.offsetLeft + 10 + scatter) + 'px'; f.style.top = (u.el.offsetTop - 4 + (Math.random() * 8 - 4)) + 'px';
    floats.appendChild(f); setTimeout(() => f.remove(), 900);
  }
};
function buildArena() {
  const u = $('units'); if(!u) return; u.innerHTML = ''; UI.refs = {};
  G.team.forEach((h, i) => {
    const d = document.createElement('div'); d.className = 'unit h'; const heroX = HPOS[i].l; d.style.left = Math.max(8, Math.min(48, heroX)) + '%'; d.style.top = Math.max(10, HPOS[i].t - 10) + '%'; d.style.transform = 'translateX(-50%)'; d.style.setProperty('--hs', HPOS[i].s); d.style.zIndex = HPOS[i].z;
    d.innerHTML = `<div class="hp"><i></i></div>${heroSvg(h.classId)}<div class="nm">${h.name}</div>`;
    const pad = document.createElement('i'); pad.className = 'pad25'; d.appendChild(pad); u.appendChild(d);
    UI.refs[h.instanceId] = { el: d, hp: d.querySelector('.hp>i'), base: 'translateX(-50%)' };
  });
  $('party').innerHTML = G.team.map(h => `<div class="pe"><div class="pt">${heroPortrait(h.classId, 'combat-portrait')}<small></small></div><div class="pi"><span class="d">${h.name}</span><div class="mh"><i></i></div><span></span></div></div>`).join('');
  $('skills').innerHTML = G.team.map((h, i) => `<button class="sb" data-act="skill" data-i="${i}" aria-label="${SKILL_DEFINITIONS[h.classId].name}"><div class="cd"></div>${HICON[h.classId]}<small>${SKILL_DEFINITIONS[h.classId].name}</small><b class="cn"></b></button>`).join('');
}
function buildEnemy(opts) {
  const enemies = G.encounter.enemies || [G.encounter.current];
  UI.encId = enemies.map(e => e.id).join('|');
  const victory = !!(opts && opts.victory);
  for (const key of Object.keys(UI.refs)) {
    if (!key.startsWith('enemy-')) continue;
    const old = UI.refs[key];
    if (victory) { old.hp.style.width = '0%'; old.el.classList.add('dying'); setTimeout(() => old.el.remove(), 650); }
    else old.el.remove();
    delete UI.refs[key];
  }
  const delay = victory ? Math.max(0, GameRefs.intermission / (window.GAME_SPEED || 1) - 0.45) : 0;
  enemies.forEach((e, index) => {
    const pos = enemies.length === 1 ? { l: EPOS.l, t: e.isBoss ? EPOS.tb : EPOS.t } : GROUP_EPOS[index];
    const d = document.createElement('div'); d.className = 'unit en entering' + (e.isElite ? ' elite' : ''); d.style.setProperty('--ed', delay.toFixed(2) + 's'); const enemyX = pos.l; const enemyY = pos.t; d.style.left = Math.max(52, Math.min(92, enemyX)) + '%'; d.style.top = Math.max(12, enemyY - 10) + '%'; d.style.transform = 'translateX(-50%)';
    d.innerHTML = `<div class="hp" style="width:${e.isBoss ? 0 : 38}px"><i></i></div>${enemySvg(e)}`;
    const epad = document.createElement('i'); epad.className = 'pad25'; d.appendChild(epad);
    $('units').appendChild(d); UI.refs['enemy-' + e.id] = { el: d, hp: d.querySelector('.hp>i'), base: 'translateX(-50%)' };
  });
  const lead = enemies[0];
  if($('arena')) $('arena').classList.toggle('boss', !!lead.isBoss);
  const tb = $('tBar'); if(tb) { tb.querySelectorAll('u').forEach(x => x.remove()); if (lead.isBoss) BOSS_DEFINITION.phases.slice(1).forEach(p => { const u = document.createElement('u'); u.style.left = (p.hpThreshold * 100) + '%'; tb.appendChild(u); }); }
}
function updateArena() {
  const enemies = G.encounter.enemies || [G.encounter.current], e = G.encounter.current; if (!e) return;
  if (UI.encId !== enemies.map(x => x.id).join('|')) buildEnemy();
  $('tgt').style.visibility = GameRefs.intermission > 0 ? 'hidden' : 'visible';
  const nextPhase = $('nextPhase');
  if (GameRefs.intermission > 0) {
    const seconds = Math.max(1, Math.ceil(GameRefs.intermission));
    nextPhase.style.display = 'block';
    nextPhase.innerHTML = `${GameRefs.combatPaused ? 'COMBATE PAUSADO · ' : ''}PRÓXIMA FASE COMEÇA EM<b>${seconds} ${seconds === 1 ? 'SEGUNDO' : 'SEGUNDOS'}</b>`;
  } else nextPhase.style.display = 'none';
  for (const enemy of enemies) {
    const ref = UI.refs['enemy-' + enemy.id]; if (!ref) continue;
    ref.hp.style.width = Math.max(0, enemy.currentHP / enemy.stats.hp * 100) + '%';
    ref.el.classList.toggle('dying', !enemy.isAlive);
  }
  const living = livingEnemies(G.encounter);
  $('tName').textContent = e.isBoss ? `${e.name} — ${e.currentPhaseLabel || 'Fase 1'}` : (enemies.length > 1 ? `Hostis restantes: ${living.length}/${enemies.length}` : e.name);
  const totalHp = enemies.reduce((sum, enemy) => sum + enemy.currentHP, 0), totalMax = enemies.length === 1 && e.baseStats ? e.baseStats.hp : enemies.reduce((sum, enemy) => sum + enemy.stats.hp, 0);
  $('tBar').firstElementChild.style.width = Math.max(0, totalHp / totalMax * 100) + '%';
  $('tSt').textContent = enemies.length > 1 ? living.map(enemy => enemy.name).join(' · ') : (e.statusEffects || []).map(s => s.typeId + (s.stacks > 1 ? 'x' + s.stacks : '')).join(' · ');
  const ab = G.abyss;
  $('dep').textContent = ab.farm ? `🎯 Treino · Prof. ${ab.depth} · fronteira ${ab.best}` : `Prof. ${ab.depth}/${ABYSS_CONFIG.maxDepth} · ${ab.bossReady ? (bossKind(ab.depth) === 'boss' ? '☠ BOSS' : '⚔ SEMI-BOSS') : ab.kills + '/' + getKillsToAdvance()} · The Hollow Depths`;
  const pl = $('phasePlate');
  if (pl) {
    pl.dataset.k = ab.farm ? 'farm' : ab.bossReady ? (bossKind(ab.depth) === 'boss' ? 'boss' : 'semi') : 'normal';
    $('phaseLbl').textContent = ab.farm ? 'TREINO' : 'FASE'; $('phaseNum').textContent = ab.depth;
    $('phaseSub').textContent = ab.farm ? 'máx. ' + ab.best : ab.bossReady ? (bossKind(ab.depth) === 'boss' ? '☠ BOSS' : '⚔ SEMI') : ab.kills + '/' + getKillsToAdvance();
    if (UI.plateDepth !== ab.depth) { UI.plateDepth = ab.depth; pl.classList.remove('pop'); void pl.offsetWidth; pl.classList.add('pop'); setTimeout(() => pl.classList.remove('pop'), 700); }
  }
  $('frontBtn').style.display = ab.farm ? 'block' : 'none'; $('frontBtn').dataset.n = ab.best;
  const pes = $('party').children;
  G.team.forEach((h, i) => {
    const r = UI.refs[h.instanceId], pct = Math.max(0, h.currentHP / h.finalStats.hp * 100), isDead = !h.isAlive;
    if(r) { r.hp.style.width = (isDead ? 100 : pct) + '%'; r.el.classList.toggle('dead', isDead); }
    const pe = pes[i]; if(!pe) return;
    pe.classList.toggle('kd', isDead); pe.querySelector('small').textContent = h.level;
    pe.querySelector('.mh>i').style.width = (isDead ? 0 : pct) + '%';
    pe.querySelector('.pi>span:last-child').textContent = isDead ? '💀 Caído' : `${Math.round(h.currentHP)}/${h.finalStats.hp}` + ((h.statusEffects||[]).length ? ' '+h.statusEffects.map(s=>s.category==='shield'?'🛡':s.typeId).join(' ') : '');
    const sb = $('skills').children[i]; if (!sb) return;
    const cdv = Math.max(0, G.skillSystem.cooldowns[h.instanceId] || 0), def = SKILL_DEFINITIONS[h.classId];
    sb.style.setProperty('--p', cdv > 0 ? (cdv / def.cooldown * 100).toFixed(1) + '%' : '0%');
    const cnEl = sb.querySelector('.cn'); if (cnEl) cnEl.textContent = cdv >= 1 ? Math.ceil(cdv) : '';
    sb.classList.toggle('off', !h.isAlive); sb.style.pointerEvents = !h.isAlive ? 'none' : '';
  });
}
/* =========================================================
   TELAS DE INTERFACE (CAMP / HERÓIS / EVOLUÇÃO)
   ========================================================= */
const CAMP_SOON = [['🔮', 'Altar de Evolução', 'Evoluir personagens'], ['🛒', 'Mercado', 'Comprar e vender']];
const BLD = { storage:['🏚','Storage'], smithy:['⚒','Forja · Smithy'], cooking:['🍖','Cooking'], levistone:['💎','Core · Levistone'] };
function bldFx(id) {
  const l = G.camp.buildingLevels[id], d = CAMP_BUILDINGS[id];
  if (id === 'storage') return `Capacidade ${CampService.storageCapacity(G.camp)}`;
  if (id === 'levistone') return `+${Math.round(d.statPerLevel * (l - 1) * 100)}% ATK da equipe`;
  if (id === 'smithy' && !CAMP_CONFIG.materialsProductionEnabled) return 'Produção pausada';
  if (id === 'cooking' && !CAMP_CONFIG.foodProductionEnabled) return 'Produção pausada';
  return `${(d.baseProd + d.prodPerLevel * (l - 1)).toFixed(2)}/s`;
}
function renderCamp() {
  const c = G.camp, b = BANNER_DEFINITIONS[0], q = c.quest, cap = CampService.storageCapacity(c);
  $('campBody').innerHTML = `
  <div class="d" style="font-size:16px;color:var(--gold)">Camp</div><div class="dim">Santuário ao redor do Core mágico</div>
  ${UI.defeatNote ? `<div class="panel" style="border-color:var(--red);margin:10px 0;font-size:12px;line-height:1.4"><b class="d" style="color:var(--red3)">💀 Derrota</b><br>${UI.defeatNote}</div>` : ''}
  <div class="row" style="margin:10px 0"><div class="chip grow">⚒ ${fmt(c.materials)}/${cap}</div><div class="chip grow">🍖 ${fmt(c.food)}/${cap}</div></div>
  ${CAMP_CONFIG.foodProductionEnabled || CAMP_CONFIG.materialsProductionEnabled ? `<div class="panel row" style="margin-bottom:10px"><div class="grow"><b class="d">Coleta durante combate: ${CAMP_CONFIG.materialsProductionEnabled ? '⚒ materiais' : ''}${CAMP_CONFIG.materialsProductionEnabled && CAMP_CONFIG.foodProductionEnabled ? ' · ' : ''}${CAMP_CONFIG.foodProductionEnabled ? '🍖 comida' : ''}</b><div class="dim">Entre no Abismo e lute para produzir e coletar recursos automaticamente. Combate pausado ou intervalo entre encontros não gera recursos.</div></div></div>` : ''}
  <div class="panel row" style="margin-bottom:10px"><div class="grow"><b class="d">${G.abyss.farm ? '🎯 Treinando · Prof. ' + G.abyss.depth : '⚔ Progredindo · Prof. ' + G.abyss.depth}</b><div class="dim">Fronteira: Prof. ${G.abyss.best}/${ABYSS_CONFIG.maxDepth} · refaça fases já concluídas</div></div><button class="btn sm pri" data-act="stages">🗺 Escolher fase</button></div>
  <div class="grid2">${Object.keys(CAMP_BUILDINGS).map(id => { const cost = CampService.upgradeCost(id, c);
    return `<div class="bld"><div class="bi">${BLD[id][0]}</div><div class="bn d">${BLD[id][1]} · Lv${c.buildingLevels[id]}</div><div class="fx">${bldFx(id)}</div><button class="btn sm pri" data-act="upg" data-id="${id}" ${c.gold < cost ? 'disabled' : ''}>Upgrade 🪙${cost}</button></div>`; }).join('')}${CAMP_SOON.map(([ic, nm, fx]) => `<div class="bld soon"><div class="bi">${ic}</div><div class="bn d">${nm}</div><div class="fx">${fx}</div><button class="btn sm sec" disabled>Em breve</button></div>`).join('')}</div>
  <div class="sec-t">Quest Board</div>
  <div class="panel row"><div class="grow">Derrote ${q.killTarget} inimigos<div class="pb" style="margin-top:4px"><i style="width:${q.killCurrent / q.killTarget * 100}%"></i></div></div><button class="btn sm pri" data-act="claim" ${G.campController.canClaimQuest() ? '' : 'disabled'}>+${q.goldReward}🪙</button></div>
  <div class="sec-t">Laboratory · Gacha</div>
  <div class="panel"><div class="row"><div class="grow d">${b.name}</div><div class="dim">Pity ${GachaService.pityCounters[b.id] || 0}/${b.pityThreshold}</div></div>
    <div class="row" style="margin-top:8px"><button class="btn grow" data-act="pull" data-n="1" ${c.gold < b.singleCost ? 'disabled' : ''}>x1 · ${b.singleCost}🪙</button><button class="btn grow" data-act="pull" data-n="10" ${c.gold < b.multiCost ? 'disabled' : ''}>x10 · ${b.multiCost}🪙</button></div>
    <div class="dim" style="margin-top:6px">${UI.pulls.length ? UI.pulls.join(' · ') : 'Cartas e Pets vão para a aba Heróis.'}</div></div>
  <div class="sec-t">Prestige</div>
  <div class="panel row"><div class="grow">Pontos ${G.prestige.points} · Rebirths ${G.prestige.rebirthCount}<div class="dim">Libera na profundidade ${PRESTIGE_CONFIG.minDepthToRebirth}+ (reseta profundidade e níveis)</div></div><button class="btn sm" data-act="rebirth" ${PrestigeService.canRebirth(G.abyss) ? '' : 'disabled'}>Rebirth</button></div>
  <div style="margin-top:14px"><button class="btn pri" data-act="formationOpen" style="width:100%;padding:12px;font-size:13px">${window.EXPEDITION_PAUSED && !UI.fresh ? 'Preparar equipe · Prof. ' + G.abyss.depth : 'Preparar formação e entrar no Abyss'}</button></div>
  <details class="dbg"><summary>Debug / testes</summary><div class="dbgb">
    <button class="btn sm" data-act="dbg" data-k="gold">+1000 🪙</button><button class="btn sm" data-act="dbg" data-k="dia">+1000 💎</button><button class="btn sm" data-act="dbg" data-k="xp">+500 XP</button>
    <button class="btn sm" data-act="dbg" data-k="heal">Curar equipe</button><button class="btn sm" data-act="dbg" data-k="cd">Zerar cooldowns</button><button class="btn sm" data-act="dbg" data-k="god">God: ${GameRefs.godMode ? 'ON' : 'OFF'}</button>
    <button class="btn sm" data-act="dbg" data-k="depth">Ir p/ profundidade…</button><button class="btn sm" data-act="dbg" data-k="boss">Spawn Boss</button>
    <button class="btn sm" data-act="dbg" data-k="eq">+Equip</button><button class="btn sm" data-act="dbg" data-k="card">+Carta</button><button class="btn sm" data-act="dbg" data-k="gem">+Gema</button><button class="btn sm" data-act="dbg" data-k="pet">+Pet</button>
    <button class="btn sm" data-act="save">Salvar agora</button><button class="btn sm sec" data-act="wipe">Apagar save</button></div></details>`;
}

function renderPetEvolution() {
  const c = G.camp;
  $('petEvoBody').innerHTML = `
  <div class="d" style="font-size:16px;color:var(--gold)">🐾 Evolução de Pets</div>
  <div class="dim" style="margin-bottom:10px">Evolua seus pets usando comida para níveis e 5 pets materiais para evoluir o estágio.</div>
  <div class="sec-t">🐾 Evolução de Pets</div>
  <div class="panel" style="margin-bottom:12px">
    <div class="row" style="margin-bottom:6px"><div class="grow"><b class="d">Comida para níveis</b><div class="dim">🍖 ${fmt(c.food)} disponível · usada para subir níveis individuais</div></div></div>
    ${(() => {
      const pets = G.inventory.pets, sel = UI.petEvolution;
      const main = pets.find(p => p.id === sel.mainPetId);
      const materials = sel.materialPetIds.map(id => pets.find(p => p.id === id)).filter(Boolean);
      const mainStage = main ? PetService.evolutionStage(main) : 0;
      const nextLimit = main && mainStage < PET_EVOLUTION_STAGE_LIMITS.length ? PET_EVOLUTION_STAGE_LIMITS[mainStage] : null;
      const petLabel = p => { const d = PetService.def(p); return `${d.name} · ${p.rarityLabel || p.rarityId} · Estágio ${PetService.evolutionStage(p)} · Lv${p.level}/${PetService.maxLevel(p)}`; };
      return `<div class="dim" style="margin:4px 0 8px">Escolha 1 pet principal e 5 pets materiais. Os materiais serão consumidos permanentemente.</div>
      <div class="panel" style="margin-bottom:8px;border-color:var(--gold6)"><b>Principal:</b> ${main ? petLabel(main) : 'Nenhum selecionado'}${main ? `<div class="dim">Após evoluir: Estágio ${mainStage + 1} · nível 1/${nextLimit} · raridade preservada</div>` : ''}</div>
      <div class="dim" style="margin-bottom:5px">Coleção — escolha o principal ou marque materiais (${materials.length}/5)</div>
      <div class="evo-grid">${pets.map(p => {
        const d = PetService.def(p), isMain = p.id === sel.mainPetId, isMat = sel.materialPetIds.includes(p.id);
        const blocked = !!main && main.id === p.id;
        const rarity = String(p.rarityId || p.rarityLabel || 'common').toLowerCase();
        const rarityClass = /legend|myth|lend/.test(rarity) ? 'legendary' : /epic|épico/.test(rarity) ? 'epic' : /rare|raro/.test(rarity) ? 'rare' : /uncommon|incomum/.test(rarity) ? 'uncommon' : 'common';
        return `<div class="evo-card ${isMain ? 'is-main' : ''} ${isMat ? 'is-material' : ''}"><div class="evo-icon ${rarityClass}">🐾</div><div class="evo-info"><b>${d.name}</b><div class="evo-sub">${p.rarityLabel || p.rarityId} · Est. ${PetService.evolutionStage(p)} · Lv${p.level}/${PetService.maxLevel(p)}</div></div><div class="evo-card-actions"><button class="btn sm ${isMain ? 'pri' : 'sec'}" data-act="petEvoMain" data-id="${p.id}" ${isMat ? 'disabled' : ''}>${isMain ? 'Principal ✓' : 'Principal'}</button><button class="btn sm ${isMat ? 'pri' : 'sec'}" data-act="petEvoMat" data-id="${p.id}" ${blocked || (!isMat && sel.materialPetIds.length >= 5) ? 'disabled' : ''}>${isMat ? 'Material ✓' : 'Material'}</button></div></div>`;
      }).join('')}</div>
      <div class="row" style="margin-top:9px"><div class="grow dim">Materiais selecionados: ${materials.length}/5</div><button class="btn sm sec" data-act="petEvoReset">Limpar</button></div>
      <button class="btn pri" data-act="petEvoConfirm" style="width:100%;margin-top:8px" ${!main || materials.length !== 5 || mainStage >= PET_EVOLUTION_STAGE_LIMITS.length ? 'disabled' : ''}>Evoluir pet · consumir 5 materiais</button>
      ${mainStage >= PET_EVOLUTION_STAGE_LIMITS.length ? '<div class="dim" style="margin-top:6px;color:var(--gold)">Este pet já atingiu o estágio máximo.</div>' : ''}`;
    })()}
  </div>`;
}

const WEAPON_EVOLUTION_STAGE_LIMITS = PET_EVOLUTION_STAGE_LIMITS;
const WeaponEvolutionSelection = {
  create() { return { mainWeaponId: null, materialWeaponIds: [] }; },
  selectMain(sel, id) { if (!id || sel.materialWeaponIds.includes(id)) return false; sel.mainWeaponId = id; return true; },
  addMaterial(sel, id) { if (!id || id === sel.mainWeaponId || sel.materialWeaponIds.includes(id) || sel.materialWeaponIds.length >= 5) return false; sel.materialWeaponIds.push(id); return true; },
  removeMaterial(sel, id) { const i = sel.materialWeaponIds.indexOf(id); if (i < 0) return false; sel.materialWeaponIds.splice(i, 1); return true; },
  isComplete(sel) { return !!sel.mainWeaponId && sel.materialWeaponIds.length === 5; }
};
function weaponStage(item) { return Math.min(WEAPON_EVOLUTION_STAGE_LIMITS.length, Math.max(1, item.evolutionStage || 1)); }
function weaponMaxLevel(item) { return WEAPON_EVOLUTION_STAGE_LIMITS[weaponStage(item) - 1]; }
function weaponForgeCost(item) { return Math.ceil(5 * Math.pow(1.35, Math.max(0, (item.level || 1) - 1))); }
function itemPower(it) { return (it.affixes || []).reduce((s, a) => { const d = AFFIX_POOL.find(p => p.id === a.id); return s + (d ? a.value / d.max : 0); }, 0) * (1 + (Number(it.upgradeBonus) || 0)); }
const itemPowerNum = it => Math.round(itemPower(it) * 100);
const RARITY_ORD = { common: 0, rare: 1, epic: 2, legendary: 3 };
const itemCmp = (a, b) => ((a.slot === 'armor') - (b.slot === 'armor')) || (itemPower(a) - itemPower(b)) || ((RARITY_ORD[a.rarityId] || 0) - (RARITY_ORD[b.rarityId] || 0)) || String(a.name).localeCompare(String(b.name));
const WEAPON_RANK_NAMES = ['Básico', 'Refinado', 'Mestre'];
const weaponRankName = item => WEAPON_RANK_NAMES[weaponStage(item) - 1] || WEAPON_RANK_NAMES[0];
const weaponRankBadge = item => `<span class="rk rk${weaponStage(item)}">${'★'.repeat(weaponStage(item) - 1)}${weaponStage(item) > 1 ? ' ' : ''}Rank ${weaponRankName(item)}</span>`;
const weaponRankStep = item => weaponStage(item) < WEAPON_EVOLUTION_STAGE_LIMITS.length ? `${weaponRankName(item)} → ${WEAPON_RANK_NAMES[weaponStage(item)]}` : `${weaponRankName(item)} (máx.)`;
const weaponRankNote = item => weaponStage(item) <= 1 ? 'Ainda no rank básico (sem evoluções).' : weaponStage(item) < WEAPON_EVOLUTION_STAGE_LIMITS.length ? `Evoluído para o rank ${weaponRankName(item)}.` : 'Rank máximo alcançado.';
function renderWeaponEvolution() {
  const c = G.camp, sel = UI.weaponEvolution || (UI.weaponEvolution = WeaponEvolutionSelection.create());
  const weapons = G.inventory.items.filter(i => i.slot === 'weapon' || i.slot === 'armor').sort(itemCmp);
  const equipped = new Set(); G.team.forEach(h => { if (h.equipment.weapon) equipped.add(h.equipment.weapon.id); if (h.equipment.armor) equipped.add(h.equipment.armor.id); });
  const main = weapons.find(i => i.id === sel.mainWeaponId);
  const materials = sel.materialWeaponIds.map(id => weapons.find(i => i.id === id)).filter(Boolean);
  const stage = main ? weaponStage(main) : 0, limit = main ? weaponMaxLevel(main) : 0;
  const cost = main ? weaponForgeCost(main) : 0;
  $('weaponEvoBody').innerHTML = `
    <div class="d" style="font-size:16px;color:var(--gold)">⚒ Evolução de Armas e Escudos</div>
    <div class="dim" style="margin-bottom:10px">Use materiais da Forja para aprimorar armas e escudos até o nível 10. Depois, sacrifique 5 itens do mesmo tipo para evoluir o rank.</div>
    <div class="panel" style="margin-bottom:12px">
      <div class="row" style="margin-bottom:8px"><div class="grow"><b class="d">Material da Forja</b><div class="dim">⚒ ${fmt(c.materials)} disponível · custo cresce a cada nível</div></div></div>
      ${main ? `<div class="panel" style="margin-bottom:8px;border-color:var(--gold6)"><b>${main.slot === 'armor' ? 'Escudo/Armadura principal' : 'Arma principal'}:</b> ${main.name}<div class="dim">${main.rarityLabel || main.rarityId} · ${weaponRankBadge(main)} · Lv${main.level || 1}/${limit} · ${main.affixes.map(affix).join(' · ')}${main.upgradeBonus ? ` · Aprimoramento +${Math.round(main.upgradeBonus*100)}%` : ''}</div><div class="dim" style="margin-top:4px">${stage < WEAPON_EVOLUTION_STAGE_LIMITS.length ? `Próxima evolução: Rank ${WEAPON_RANK_NAMES[stage]} · nível 1/${WEAPON_EVOLUTION_STAGE_LIMITS[stage]} · raridade preservada` : 'Rank máximo alcançado.'}</div><button class="btn pri" data-act="weaponLevelUp" style="width:100%;margin-top:8px" ${((main.level || 1) >= limit || c.materials < cost) ? 'disabled' : ''}>Aprimorar nível · ⚒ ${fmt(cost)}</button></div>` : '<div class="panel" style="margin-bottom:8px">Selecione uma arma principal abaixo para ver os aprimoramentos.</div>'}
      <div class="dim" style="margin:4px 0 8px">Armas e escudos disponíveis — selecione um item principal ou marque 5 materiais do mesmo tipo (${materials.length}/5). Itens equipados ficam protegidos. Ordenados do mais fraco ao mais forte (⚡ = poder).</div>
      <div class="evo-grid">${weapons.map(w => {
        const isMain = w.id === sel.mainWeaponId, isMat = sel.materialWeaponIds.includes(w.id), isEquipped = equipped.has(w.id), blocked = !!main && main.id === w.id;
        const rarity = String(w.rarityId || w.rarityLabel || 'common').toLowerCase();
        const rarityClass = /legend|myth|lend/.test(rarity) ? 'legendary' : /epic|épico/.test(rarity) ? 'epic' : /rare|raro/.test(rarity) ? 'rare' : /uncommon|incomum/.test(rarity) ? 'uncommon' : 'common';
        return `<div class="evo-card ${isMain ? 'is-main' : ''} ${isMat ? 'is-material' : ''}"><div class="evo-icon ${rarityClass}">${w.slot === 'armor' ? '🛡' : '⚔'}</div><div class="evo-info"><b>${w.name}</b><div class="evo-sub">${w.rarityLabel || w.rarityId} · ${w.slot === 'armor' ? 'Escudo' : 'Arma'} · ${weaponRankBadge(w)} · Lv${w.level || 1}/${weaponMaxLevel(w)} · ⚡${itemPowerNum(w)}${isEquipped ? ' · Equipada' : ''}</div></div><div class="evo-card-actions"><button class="btn sm ${isMain ? 'pri' : 'sec'}" data-act="weaponEvoMain" data-id="${w.id}" ${isMat ? 'disabled' : ''}>${isMain ? 'Principal ✓' : 'Principal'}</button><button class="btn sm ${isMat ? 'pri' : 'sec'}" data-act="weaponEvoMat" data-id="${w.id}" ${isEquipped || blocked || (!isMat && sel.materialWeaponIds.length >= 5) ? 'disabled' : ''}>${isMat ? 'Material ✓' : 'Material'}</button></div></div>`;
      }).join('') || '<div class="dim">Nenhuma arma ou escudo no inventário. Obtenha equipamentos no Abismo para começar.</div>'}</div>
      <div class="row" style="margin-top:9px"><div class="grow dim">Armas materiais selecionadas: ${materials.length}/5</div><button class="btn sm sec" data-act="weaponEvoReset">Limpar</button></div>
      <button class="btn pri" data-act="weaponEvoConfirm" style="width:100%;margin-top:8px" ${!main || materials.length !== 5 || stage >= WEAPON_EVOLUTION_STAGE_LIMITS.length || (main.level || 1) < limit ? 'disabled' : ''}>Evoluir rank · consumir 5 itens do mesmo tipo</button>
      ${stage >= WEAPON_EVOLUTION_STAGE_LIMITS.length ? '<div class="dim" style="margin-top:6px;color:var(--gold)">Este item já atingiu o rank máximo.</div>' : main && (main.level || 1) < limit ? '<div class="dim" style="margin-top:6px">Aprimore o item até o nível máximo do estágio para liberar a evolução.</div>' : ''}
    </div>`;
}

const CFX = { burn:'Ataques queimam o alvo', double_cast:'25% de atacar 2x', elemental_amp:'+30% dano de skill' };
const PFX = { burst_damage:'Dano bruto a cada 6s', team_heal:'Cura + shield na equipe', heal_lowest:'Cura o mais ferido' };
const affix = a => `+${a.type === 'percent' ? (a.value * 100).toFixed(1) + '%' : a.value.toFixed(2)} ${a.label}`;
const eqSet = () => { const s = new Set(); G.team.forEach(h => { ['weapon','armor'].forEach(k => h.equipment[k] && s.add(h.equipment[k].id)); h.card && s.add(h.card.id); h.gemSlots.forEach(g => g && s.add(g.id)); }); return s; };
function cardMergeAll(apply) {
  const eq = eqSet(), free = G.inventory.cards.filter(c => !eq.has(c.id)), mx = CardService.maxLevel(), groups = new Map();
  free.forEach(c => { const k = c.defId + '|' + c.stars; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); });
  const made = new Set(), used = []; let pairs = 0;
  groups.forEach(cards => {
    const byLv = {}; cards.forEach(c => (byLv[c.level] = byLv[c.level] || []).push(c));
    for (let lv = 1; lv < mx; lv++) {
      const arr = byLv[lv] || [];
      while (arr.length >= 2) {
        const a = arr.pop(), b = arr.pop(), m = CardService.combine(a, b); pairs++;
        [a, b].forEach(x => { if (made.has(x)) made.delete(x); else used.push(x); });
        made.add(m); (byLv[lv + 1] = byLv[lv + 1] || []).push(m);
      }
    }
  });
  if (apply && pairs) { used.forEach(x => G.inventory.removeCard(x.id)); made.forEach(m => G.inventory.addCard(m)); }
  return { pairs, used: used.length, made: [...made] };
}
function cardBulkPanel() {
  const p = cardMergeAll(false);
  return `<div class="panel row" style="margin-bottom:8px"><div class="grow dim" style="font-size:11px">Combine 2 cartas iguais (mesmo tipo, ★ e nível) em 1 carta de nível +1. Cartas equipadas não entram.</div>${p.pairs ? `<button class="btn sm pri" data-act="mixAllCards">Combinar tudo (${p.pairs})</button>` : ''}</div>`;
}
function cardUpgradeCost(card) { return Math.ceil(25 * Math.pow(1.35, Math.max(0, (card?.level || 1) - 1))); }
function cardUpgradeSummary(card) { const v = CardService.statValue(card); return `Bônus atual: +${v.type === 'percent' ? (v.value * 100).toFixed(1) + '%' : v.value.toFixed(2)} ${v.stat}`; }

function renderHeroes() {
  const h = G.team[UI.hi], s = h.finalStats, eq = eqSet(), inv = G.inventory, cls = h.classId;
  const slot = (it, ico, lbl, r, k) => `<div class="slot ${it ? rc(r) : 'r-empty'}${it && (k === 'weapon' || k === 'armor') && weaponStage(it) > 1 ? ' evo' + weaponStage(it) : ''}"${it && k ? ` data-act="itemInfo" data-k="${k}" style="cursor:pointer"` : ''} title="${it ? it.affixes ? it.affixes.map(affix).join(', ') : '' : ''}">${it ? ico : '+'}${it && (k === 'weapon' || k === 'armor') ? `<i class="rkb rk${weaponStage(it)}">${['I', 'II', 'III'][weaponStage(it) - 1]}</i>` : ''}<small>${lbl}</small></div>`;
  const gems = h.gemSlots.map((g, i) => g ? `<div class="slot ${rc(gemR(g.level))}">◆<small>${GemService.gemValue(g).label} L${g.level}</small><button class="x" data-act="unsock" data-i="${i}">✕</button></div>` : slot(null, '', 'Gem ' + (i + 1)));
  let list = '';
  if (UI.ct === 'items') list = `<div class="panel row" style="margin-bottom:8px"><div class="grow">Material da Forja disponível</div><b>⚒ ${fmt(G.camp.materials)}</b><button class="btn sm sec" data-act="salvageOpen" style="margin-left:8px">♻ Desmontar</button></div><div class="dim" style="margin:-2px 0 6px;font-size:10px">Ordenado do mais fraco ao mais forte · ⚡ = poder do item</div>` + inv.items.filter(i => !eq.has(i.id)).sort(itemCmp).map(i => { const upgradeable = i.slot === 'weapon' || i.slot === 'armor', cost = upgradeable ? weaponForgeCost(i) : 0, canLevel = upgradeable && (i.level || 1) < weaponMaxLevel(i), canAfford = G.camp.materials >= cost; return `<div class="li"><div class="ic ${rc(i.rarityId)}">${i.slot === 'weapon' ? '🗡' : '🛡'}</div><div class="tx">${i.name}${upgradeable ? ` · Lv${i.level || 1}/${weaponMaxLevel(i)} · ⚡${itemPowerNum(i)}` : ''}<small>${i.affixes.map(affix).join(' · ')}</small></div><div class="ac"><button class="btn sm" data-act="eqItem" data-id="${i.id}">Equipar</button>${upgradeable ? `<button class="btn sm sec" data-act="weaponLevelItem" data-id="${i.id}" ${!canLevel || !canAfford ? 'disabled' : ''}>⬆ ⚒ ${fmt(cost)}</button>` : ''}</div></div>`; }).join('');
  if (UI.ct === 'gems') { const free = inv.gems.filter(g => !eq.has(g.id));
    list = free.map(g => { const v = GemService.gemValue(g), mate = free.find(o => GemService.canCombine(g, o));
      return `<div class="li"><div class="ic ${rc(gemR(g.level))}">◆</div><div class="tx">${v.label} Lv${g.level}<small>+${v.type === 'percent' ? (v.value * 100).toFixed(1) + '%' : v.value.toFixed(3)} ${v.stat}</small></div><div class="ac"><button class="btn sm" data-act="eqGem" data-id="${g.id}">Socket</button>${mate ? `<button class="btn sm sec" data-act="mix" data-a="${g.id}" data-b="${mate.id}">Combinar</button>` : ''}</div></div>`; }).join(''); }
  if (UI.ct === 'cards') list = `<div class="panel row" style="margin-bottom:8px"><div class="grow">Moedas disponíveis para cartas</div><b>🪙 ${fmt(G.camp.gold)}</b></div>${cardBulkPanel()}` + inv.cards.map(c => { const d = CardService.def(c), cost = cardUpgradeCost(c), maxed = c.level >= CardService.maxLevel(c), equipped = eq.has(c.id), canAfford = G.camp.gold >= cost, mate = !equipped ? inv.cards.find(o => !eq.has(o.id) && CardService.canCombine(c, o)) : null;
    return `<div class="li"><div class="ic ${rc(starR(c.stars))}">🃏</div><div class="tx">${d.name} ${'★'.repeat(c.stars)} · Lv${c.level}/${CardService.maxLevel(c)}${equipped ? ' · Equipada' : ''}<small>${CFX[d.effect]} · ${cardUpgradeSummary(c)}</small></div><div class="ac">${!equipped ? `<button class="btn sm" data-act="eqCard" data-id="${c.id}">Equipar</button>` : ''}<button class="btn sm sec" data-act="upCard" data-id="${c.id}" ${maxed || !canAfford ? 'disabled' : ''}>⬆ 🪙 ${fmt(cost)}</button>${mate ? `<button class="btn sm sec" data-act="mixCard" data-a="${c.id}" data-b="${mate.id}">Combinar</button>` : ''}</div></div>`; }).join('');
  if (UI.ct === 'pets') list = `<div class="panel row" style="margin-bottom:8px"><div class="grow">Comida · Essência de Pet</div><b>🍖 ${fmt(G.camp.food)} · ✨ ${fmt(CurrencyService.getBalance(G.camp, 'petEssence'))}</b><button class="btn sm sec" data-act="petSalvageOpen" style="margin-left:8px">♻ Desmontar</button></div>` + inv.pets.map(p => { const d = PetService.def(p), st = p.id === G.petRoster.activeId ? 'ATIVO' : G.petRoster.benchIds.includes(p.id) ? 'bench' : 'livre';
    const cost = PetService.upgradeFoodCost(p), canLevel = p.level < PetService.maxLevel(p), canAfford = G.camp.food >= cost;
    return `<div class="li"><div class="ic ${rc(p.rarityId)}">🐾</div><div class="tx">${d.name} Lv${p.level}/${PetService.maxLevel(p)} · ${st}<small>${PFX[d.activeEffect]} · aura +${(d.aura.perLevel * p.level * 100).toFixed(1)}% ${d.aura.stat}</small></div><div class="ac"><button class="btn sm" data-act="pAct" data-id="${p.id}">Ativo</button><button class="btn sm sec" data-act="pBench" data-id="${p.id}">Bench</button><button class="btn sm sec" data-act="pUp" data-id="${p.id}" ${!canLevel || !canAfford ? 'disabled' : ''}>⬆ 🍖 ${cost}</button></div></div>`; }).join('');
  $('heroBody').innerHTML = `
  <div class="hero-tabs">${G.team.map((x, i) => `<div class="ht ${i === UI.hi ? 'on' : ''}" data-act="hsel" data-i="${i}" title="${x.name}">${heroPortrait(x.classId, 'tab-portrait')}<small>Lv ${x.level}</small></div>`).join('')}</div>
  <div class="collection-shortcuts" role="group" aria-label="Categorias da coleção">
    ${[['items','⚔','Itens'],['gems','◆','Gemas'],['cards','▤','Cartas'],['pets','♞','Pets']].map(([k,ic,l]) => `<button type="button" class="collection-shortcut ${UI.ct === k ? 'on' : ''}" data-act="ctab" data-k="${k}" aria-label="Coleção: ${l}" title="${l}"><span class="collection-glyph glyph-${k}">${ic}</span><span>${l}</span></button>`).join('')}
  </div>
  <div class="panel hp2">${cls === 'warrior' ? `<img class="hero-portrait panel-portrait fullbody-portrait" src="${WARRIOR_FULLBODY_PANEL}" alt="Guerreiro de corpo inteiro">` : cls === 'archer' ? `<img class="hero-portrait panel-portrait fullbody-portrait" src="${ARCHER_FULLBODY_PANEL}" alt="Arqueira de corpo inteiro">` : cls === 'mage' ? `<img class="hero-portrait panel-portrait fullbody-portrait" src="${MAGE_FULLBODY_PANEL}" alt="Mago de corpo inteiro">` : heroPortrait(cls, 'panel-portrait')}<div class="grow"><div class="row"><span class="d grow" style="font-size:15px">${h.name}</span><span class="dim">Lv ${h.level}</span></div>
    <div class="pb" style="margin-top:4px"><i style="width:${h.experience / h.xpToNextLevel() * 100}%"></i></div><div class="dim" style="font-size:9px">XP ${Math.floor(h.experience)}/${h.xpToNextLevel()}</div>
    <div class="stats"><span>HP</span><span>${s.hp}</span><span>ATK</span><span>${s.atk}</span><span>DEF</span><span>${s.def}</span><span>Vel.</span><span>${s.atkSpeed.toFixed(2)}</span><span>Crit</span><span>${(s.critRate * 100).toFixed(0)}%</span><span>Crit Dmg</span><span>${s.critDmg.toFixed(2)}x</span></div></div></div>
  <div class="sec-t">Equipamento · toque no item para ver os status</div>
  <div class="slots" style="margin-bottom:8px">${slot(h.equipment.weapon, '🗡', 'Weapon', h.equipment.weapon && h.equipment.weapon.rarityId, 'weapon')}${slot(h.equipment.armor, '🛡', 'Armor', h.equipment.armor && h.equipment.armor.rarityId, 'armor')}${slot(h.card, '🃏', 'Card', h.card && starR(h.card.stars), 'card')}${gems.join('')}</div>
  ${h.equipment.weapon ? `<div class="panel" style="margin:0 0 16px"><div class="row"><div class="grow"><b>⚒ Material da Forja</b><div class="dim">Disponível: ⚒ ${fmt(G.camp.materials)}</div></div><button class="btn sm sec" data-act="weaponLevelItem" data-id="${h.equipment.weapon.id}" ${((h.equipment.weapon.level || 1) >= weaponMaxLevel(h.equipment.weapon) || G.camp.materials < weaponForgeCost(h.equipment.weapon)) ? 'disabled' : ''}>⬆ ⚒ ${fmt(weaponForgeCost(h.equipment.weapon))}</button></div><div class="dim" style="margin-top:5px">Arma: ${weaponRankBadge(h.equipment.weapon)} Lv${h.equipment.weapon.level || 1}/${weaponMaxLevel(h.equipment.weapon)}</div><button class="btn pri" data-act="weaponEvoFromHero" data-id="${h.equipment.weapon.id}" style="width:100%;margin-top:8px">Evoluir rank · ${weaponRankStep(h.equipment.weapon)} · Lv${h.equipment.weapon.level || 1}/${weaponMaxLevel(h.equipment.weapon)}</button></div>` : `<div class="dim" style="margin:0 0 16px">Equipe uma arma para acessar sua evolução por aqui.</div>`}
  ${h.card ? `<div class="panel" style="margin:0 0 16px"><div class="row"><div class="grow"><b>🃏 Evolução da Carta</b><div class="dim">${CardService.def(h.card).name} · Lv${h.card.level}/${CardService.maxLevel(h.card)}</div><div class="dim">${cardUpgradeSummary(h.card)}</div><div class="dim">Moedas disponíveis: 🪙 ${fmt(G.camp.gold)} · Custo próximo nível: 🪙 ${fmt(cardUpgradeCost(h.card))}</div></div><button class="btn sm sec" data-act="upCard" data-id="${h.card.id}" ${h.card.level >= CardService.maxLevel(h.card) || G.camp.gold < cardUpgradeCost(h.card) ? 'disabled' : ''}>⬆ 🪙 ${fmt(cardUpgradeCost(h.card))}</button></div></div>` : ''}
  <div class="sec-t">Talentos · ${h.talentPoints} pts</div>
  ${h.equipment.armor ? `<div class="panel" style="margin:0 0 16px"><div class="row"><div class="grow"><b>🛡 Evolução de escudo/armadura</b><div class="dim">Disponível: ⚒ ${fmt(G.camp.materials)} · ${weaponRankBadge(h.equipment.armor)} Lv${h.equipment.armor.level || 1}/${weaponMaxLevel(h.equipment.armor)}</div></div><button class="btn sm sec" data-act="weaponLevelItem" data-id="${h.equipment.armor.id}" ${((h.equipment.armor.level || 1) >= weaponMaxLevel(h.equipment.armor) || G.camp.materials < weaponForgeCost(h.equipment.armor)) ? 'disabled' : ''}>⬆ ⚒ ${fmt(weaponForgeCost(h.equipment.armor))}</button></div><button class="btn pri" data-act="weaponEvoFromHero" data-id="${h.equipment.armor.id}" style="width:100%;margin-top:8px">Evoluir rank · ${weaponRankStep(h.equipment.armor)} · Lv${h.equipment.armor.level || 1}/${weaponMaxLevel(h.equipment.armor)}</button></div>` : ''}
  <div class="talent-grid">${TALENT_TREES[cls].map(n => { const r = h.talents[n.id] || 0; const art = TALENT_ICON_MAP[n.id] || TALENT_ICON_MAP.vitality_w; return `<div class="talent-card"><img class="talent-art" src="${art}" alt="${n.label}"><div class="talent-name">${n.label}</div><div class="talent-rank">Nv. ${r}/${n.maxRank}</div><button class="btn sm" data-act="tal" data-n="${n.id}" ${h.talentPoints <= 0 || r >= n.maxRank ? 'disabled' : ''}>+ Evoluir</button></div>`; }).join('')}</div>
  <div class="sec-t">Coleção · ${{items:'Itens',gems:'Gemas',cards:'Cartas',pets:'Pets'}[UI.ct] || 'Itens'}</div>
  ${list || '<div class="dim" style="padding:10px">Vazio — derrote inimigos, abra o Gacha ou use Debug.</div>'}`;
}

/* =========================================================
   DERROTA / VITÓRIA / FASES / MODAIS
   ========================================================= */
function startFreshEncounter() {
  const enemies = G.abyss.bossReady ? [spawnEnemyForDepth(G.abyss.depth, true)] : spawnCommonEncounter(G.abyss.depth);
  setEncounter(G.encounter, enemies);
  EventBus.emit('OnCombatStarted', { depth: G.abyss.depth, enemy: enemies[0].name, enemyCount: enemies.length, isBoss: !!enemies[0].isBoss });
}
const DEFEAT_PENALTY = { itemRate: 0.5, goldRate: 0.1, pendingRate: 0.1 };
function trackRunLoot(kind, obj) { (GameRefs.runLoot = GameRefs.runLoot || []).push({ kind, id: obj.id }); }
function runLootEligible() {
  const inv = G.inventory, eq = eqSet(), r = G.petRoster, out = [];
  (GameRefs.runLoot || []).forEach(e => {
    if (e.kind === 'item') { const o = inv.items.find(i => i.id === e.id); if (o && !eq.has(o.id) && !isInvested(o)) out.push({ kind: 'item', id: o.id, label: o.name }); }
    else if (e.kind === 'gem') { const o = inv.gems.find(g => g.id === e.id); if (o && !eq.has(o.id)) out.push({ kind: 'gem', id: o.id, label: `Gema ${GemService.gemValue(o).label} Lv${o.level}` }); }
    else if (e.kind === 'card') { const o = inv.cards.find(cd => cd.id === e.id); if (o && !eq.has(o.id) && (o.level || 1) <= 1) out.push({ kind: 'card', id: o.id, label: `Carta ${CardService.def(o).name} ${o.stars}★` }); }
    else if (e.kind === 'pet') { const o = inv.pets.find(p => p.id === e.id); if (o && o.id !== r.activeId && !r.benchIds.includes(o.id) && !petInvested(o)) out.push({ kind: 'pet', id: o.id, label: `Pet ${PetService.def(o).name}` }); }
  });
  return out;
}
function applyDefeatPenalty() {
  const inv = G.inventory, elig = runLootEligible(), n = elig.length, half = n * DEFEAT_PENALTY.itemRate;
  const lose = Math.floor(half) + ((half % 1) && Math.random() < 0.5 ? 1 : 0);
  const pool = elig.slice(); for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const lost = pool.slice(0, lose);
  lost.forEach(e => { if (e.kind === 'item') inv.removeItem(e.id); else if (e.kind === 'gem') inv.removeGem(e.id); else if (e.kind === 'card') inv.removeCard(e.id); else inv.removePet(e.id); });
  const gold = Math.floor(CurrencyService.getBalance(G.camp, 'gold') * DEFEAT_PENALTY.goldRate); if (gold > 0) CurrencyService.removeCurrency(G.camp, 'gold', gold);
  const pend = {}; ['materials', 'food'].forEach(k => { const v = Math.floor((G.camp.pending[k] || 0) * DEFEAT_PENALTY.pendingRate); if (v > 0) { G.camp.pending[k] -= v; pend[k] = v; } });
  GameRefs.runLoot = [];
  return { lost, gold, pend, eligible: n };
}
function penaltyText(p) {
  const parts = []; if (p.lost.length) parts.push(`${p.lost.length} ${p.lost.length === 1 ? 'item perdido' : 'itens perdidos'}`);
  if (p.gold) parts.push(`🪙 −${p.gold}`); if (p.pend.materials) parts.push(`⚒ −${p.pend.materials} (coleta)`); if (p.pend.food) parts.push(`🍖 −${p.pend.food} (coleta)`);
  return parts.join(' · ');
}
function showDefeatPenalty(p) {
  const list = p.lost.slice(0, 8).map(e => `<div class="li"><div class="tx">${e.label}</div></div>`).join('') + (p.lost.length > 8 ? `<div class="dim">… e mais ${p.lost.length - 8}</div>` : '');
  showOv(`<h2 class="d" style="font-size:18px;color:var(--red3)">☠ Penalidade da derrota</h2>
    <div class="dim" style="margin:4px 0 8px">Metade do que você coletou nesta expedição se perdeu na queda.</div>
    ${p.lost.length ? `<div class="dlist">${list}</div>` : `<div class="dim" style="padding:6px 0">Nenhum item da expedição foi perdido${p.eligible ? '' : ' (você não tinha itens desprotegidos coletados nela)'}.</div>`}
    <div class="panel" style="margin-top:8px">${p.gold ? `🪙 Ouro: <b>−${p.gold}</b> (10%)<br>` : ''}${p.pend.materials ? `⚒ Coleta do Acampamento: <b>−${p.pend.materials}</b> (10%)<br>` : ''}${p.pend.food ? `🍖 Coleta do Acampamento: <b>−${p.pend.food}</b> (10%)<br>` : ''}${!p.gold && !p.pend.materials && !p.pend.food ? 'Ouro e coleta do Acampamento: nada a perder.' : ''}</div>
    <div class="dim" style="font-size:10px;margin-top:6px">Itens equipados, pet ativo/reserva e itens aprimorados ficam protegidos.</div>
    <button class="btn pri" data-act="closeOv" style="width:100%;padding:11px;margin-top:10px">Continuar</button>`, true);
}
function handleDefeat() {
  if (UI.defeating) return; UI.defeating = true;
  try {
    const dep = G.abyss.depth, boss = !!(G.encounter.current && G.encounter.current.isBoss);
    G.team.forEach(h => { h.currentHP = h.finalStats.hp; h.statusEffects = []; h._atkTimer = 0; });
    for (const k in G.skillSystem.cooldowns) G.skillSystem.cooldowns[k] = 0;
    G.abyss.bossReady = false; G.abyss.kills = 0;
    startFreshEncounter(); window.EXPEDITION_PAUSED = true;
    const pen = applyDefeatPenalty(), penTxt = penaltyText(pen);
    UI.defeatNote = `Sua equipe caiu ${boss ? 'diante do Boss' : 'na Profundidade ' + dep} e foi recuperada no Camp. Toque em “Voltar ao Abyss” para tentar de novo.${penTxt ? '<br>☠ Penalidade: ' + penTxt + '.' : ''}`;
    if (UI.onEnemySpawn) UI.onEnemySpawn();
    G.save.save(); goto('camp'); toast('💀 Equipe caída — recuperada no Camp');
    if (pen.lost.length || pen.gold || pen.pend.materials || pen.pend.food) showDefeatPenalty(pen);
  } finally { UI.defeating = false; }
}
function showVictory(p) {
  if (UI.screen !== 'abyss') return;
  G.team.forEach(h => { if (h.isAlive) UI.flag(h.instanceId, 'cheer', 600); });
  const b = document.createElement('div');
  b.className = 'victory-banner' + (p.isBoss ? ' boss' : (p.isElite ? ' elite' : ''));
  const title = p.isBoss ? '☠ BOSS DERROTADO!' : p.isSemi ? '⚔ SEMI-BOSS DERROTADO!' : (p.isElite ? '★ ELITE DERROTADO!' : '⚔ VITÓRIA!');
  b.innerHTML = `<b>${title}</b><span>${p.name}</span><span>🪙 +${p.gold} · ✨ +${p.xp} XP</span>${p.loot.length ? `<span class="lt">🎁 ${p.loot.slice(0, 3).join(' · ')}${p.loot.length > 3 ? ' …' : ''}</span>` : ''}`;
  $('arena').appendChild(b); setTimeout(() => b.remove(), p.isBoss ? 2300 : 1450);
}
function showStageClear(sc) {
  const max = ABYSS_CONFIG.maxDepth, n = sc.next, big = 'padding:14px;font-size:14px';
  const nextTxt = n ? `Fase ${n}` + (isBossPhase(n) ? (bossKind(n) === 'boss' ? ` · Boss: ${BOSS_DEFINITION.name}` : ' · Semi-boss') : '') : 'Última fase da região';
  const stars = Math.max(0, Math.min(3, sc.stars || 0)), newStars = Math.max(0, Math.min(3, sc.newStars || 0)), perfect = stars === 3 && sc.newRecord;
  const starPanel = `<div class="stage-star-result${perfect ? ' perfect' : ''}" role="status" aria-live="polite">
    <div class="sr-label">${perfect ? '✦ CLASSIFICAÇÃO MÁXIMA! ✦' : (newStars > 0 ? 'ESTRELAS CONQUISTADAS' : 'MELHOR CLASSIFICAÇÃO')}</div>
    <div class="sr-stars" aria-label="${stars} de 3 estrelas">${[0,1,2].map(i => `<span style="color:${i < stars ? 'var(--gold)' : 'var(--t3)'}">${i < stars ? '★' : '☆'}</span>`).join('')}</div>
    <div class="sr-note">${newStars > 0 ? `Você ganhou ${newStars} estrela${newStars === 1 ? '' : 's'} nova${newStars === 1 ? '' : 's'}!` : 'Você não superou sua classificação anterior.'}</div>
    ${sc.crystals > 0 ? `<div class="sr-crystals">💎 +${sc.crystals} cristal${sc.crystals === 1 ? '' : 'is'}</div>` : ''}
    ${perfect ? '<div class="sr-note" style="color:#ffe08a;font-weight:900;margin-top:4px">PERFEITO · 3/3 ESTRELAS</div>' : ''}
  </div>`;
  showOv(`<h2 class="d" style="font-size:20px;letter-spacing:.04em">✓ FASE ${sc.depth} CONCLUÍDA!</h2>
    <div class="dim" style="margin-top:4px">The Hollow Depths</div>
    ${starPanel}
    <div class="dim" style="margin:2px 0 16px">Próxima: <b style="color:var(--gold)">${nextTxt}</b></div>
    ${n ? '<div class="d" style="margin:-6px 0 14px;color:var(--cy)">Próxima fase começa em <b id="stageNextCountdown">5</b> segundos</div>' : ''}
    <div class="ov-actions row-ls">
      <button class="btn pri" data-act="stageNext" style="${big}" ${n ? '' : 'disabled'}>⚔️ Prosseguir</button>
      <button class="btn" data-act="stageRepeat" style="${big}">🔄 Repetir fase</button>
      <button class="btn sec" data-act="stageCamp" style="${big}">🏰 Voltar ao Acampamento</button>
    </div>`);
  if (perfect) { const panel = document.querySelector('.stage-star-result.perfect'); if (panel) { panel.animate([{transform:'scale(.92)',opacity:.7},{transform:'scale(1.04)',opacity:1},{transform:'scale(1)',opacity:1}],{duration:650,easing:'cubic-bezier(.2,1.5,.4,1)'}); } }
}
function showStages() {
  const A = G.abyss, max = ABYSS_CONFIG.maxDepth;
  let totalStars = 0, clearedStages = 0;
  for (let depth = 1; depth <= A.best; depth++) { const earned = G.stageStars.get(depth); totalStars += earned; if (earned > 0) clearedStages++; }
  const starGoal = Math.max(1, A.best) * 3, starPercent = Math.round(totalStars / starGoal * 100), crystals = G.camp.currencies?.diamonds || 0;
  const progressPanel = `<div class="panel" style="margin:10px 0;border-color:var(--gold6)">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:6px">
      <div><div class="dim">ESTRELAS CONQUISTADAS</div><b class="d" style="font-size:20px;color:var(--gold)">⭐ ${totalStars} <span class="dim" style="font-size:12px">/ ${starGoal}</span></b></div>
      <div style="text-align:right"><div class="dim">CRISTAIS ACUMULADOS</div><b class="d" style="font-size:20px;color:var(--cy)">💎 ${fmt(crystals)}</b></div>
    </div>
    <div class="pb" style="margin:8px 0 5px"><i style="width:${starPercent}%;background:linear-gradient(90deg,var(--gold6),var(--gold))"></i></div>
    <div class="dim">${clearedStages}/${A.best} fases com classificação · ${starPercent}% das estrelas possíveis nas fases alcançadas</div>
  </div>`;
  let rows = '';
  for (let d = 1; d <= A.best; d++) {
    const cur = d === A.depth, boss = d >= max, st = d < A.best ? '✓ Concluída' : (boss ? '☠ Boss' : '⚔ Fronteira');
    const rw = `🪙 ${8 + Math.floor(d * 1.5)} · ✨ ${5 + d} XP por inimigo` + (isBossPhase(d) ? (bossKind(d) === 'boss' ? ' · ☠ Boss no fim' : ' · ⚔ Semi-boss no fim') : '');
    const lbl = cur ? 'Aqui' : (d < A.best ? 'Treinar' : 'Continuar'), earnedStars = G.stageStars.get(d);
    const starDisplay = `<span class="stars" aria-label="${earnedStars} de 3 estrelas">${'★'.repeat(earnedStars)}<span class="empty">${'☆'.repeat(3 - earnedStars)}</span></span>`;
    rows += `<div class="srow${cur ? ' cur' : ''}${d === A.best ? ' fr' : ''}"><div class="sn d">${d}</div><div class="si"><b>${st}</b>${cur ? ' · ▶ atual' : ''}${starDisplay}<br>${rw}</div><button class="btn sm ${d < A.best ? '' : 'pri'}" data-act="pickDepth" data-n="${d}" ${cur ? 'disabled' : ''}>${lbl}</button></div>`;
  }
  showOv(`<h2 class="d" style="font-size:16px">🗺 Mapa do Abismo</h2><div class="dim">The Hollow Depths · fronteira: Prof. ${A.best}/${max}${A.farm ? ' · 🎯 treinando Prof. ' + A.depth : ''}</div>${progressPanel}<div class="stglist">${rows}</div><button class="btn sec" data-act="closeOv" style="width:100%;padding:10px">Fechar</button>`);
  const cur = $('ovb').querySelector('.srow.cur'); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
}
const recalcAll = () => G.team.forEach(h => h.recalculate());
function goto(s) {
  UI.screen = s; document.querySelectorAll('.scr').forEach(x => x.classList.toggle('on', x.id === 'sc-' + s));
  document.querySelectorAll('.nb').forEach(b => b.classList.toggle('on', b.dataset.s === s));
  if (s === 'camp') renderCamp(); if (s === 'heroes') renderHeroes(); if (s === 'pets') renderPetEvolution(); if (s === 'weapons') renderWeaponEvolution();
}
function renderFormation() {
  if (!UI.formationSlots || UI.formationSlots.length !== G.team.length) UI.formationSlots = G.team.map((_, i) => G.team.length - i);
  const n = G.team.length, LBL = ['Frente', 'Meio', 'Fundo'], formationX = { 1: 20, 2: 50, 3: 80 };
  const slots = [1, 2, 3].filter(p => p <= n).map(p => {
    const pi = n - p, P = HPOS[pi], hi = UI.formationSlots.indexOf(p), h = G.team[hi];
    return `<div class="fslot ${UI.formationSel === p ? 'sel' : ''}" data-act="formationTap" data-slot="${p}" style="left:${formationX[p]}%;top:30%;z-index:2;--hs:${(P.s * 0.96).toFixed(2)}">${heroSvg(h.classId)}<i class="pad25"></i><small class="fnm">${h.name}</small><small class="fpos">${LBL[pi]}</small></div>`;
  }).join('');
  const sel = UI.formationSel != null ? G.team[UI.formationSlots.indexOf(UI.formationSel)] : null;
  showOv(`<h2 class="d" style="font-size:18px">⚔ Formação de Combate</h2><div class="dim">Toque em um herói e depois na posição para onde ele vai: os dois trocam de lugar. É a mesma disposição da arena e será aplicada ao entrar no Abismo.</div>
    <div class="fboard ${sel ? 'pick' : ''}">${slots}<div class="fenemy">INIMIGOS<br>→</div></div>
    <div class="dim" style="min-height:16px;text-align:center">${sel ? `Selecionado: <b>${sel.name}</b> — toque na posição de destino.` : 'Nenhum herói selecionado.'}</div>
    <div class="row" style="margin-top:12px"><button class="btn sec grow" data-act="formationReset">Restaurar ordem</button><button class="btn pri grow" data-act="formationStart">Confirmar e entrar</button></div>`);
}

const ACT = {
  formationOpen: () => { UI.formationSlots = G.team.map((_, i) => G.team.length - i); UI.formationSel = null; renderFormation(); },
  formationTap: d => { const p = +d.slot; if (!UI.formationSlots || !(p >= 1 && p <= G.team.length)) return; if (UI.formationSel == null) { UI.formationSel = p; return renderFormation(); } if (UI.formationSel === p) { UI.formationSel = null; return renderFormation(); } const a = UI.formationSlots.indexOf(UI.formationSel), b = UI.formationSlots.indexOf(p); if (a >= 0 && b >= 0) { UI.formationSlots[a] = p; UI.formationSlots[b] = UI.formationSel; } UI.formationSel = null; renderFormation(); },
  formationReset: () => { UI.formationSlots=G.team.map((_,i)=>G.team.length-i); UI.formationSel = null; renderFormation(); },
  formationStart: () => { const slots=UI.formationSlots || G.team.map((_,i)=>i+1); if (new Set(slots).size!==G.team.length) return toast('Cada herói precisa de uma posição diferente'); const ordered=G.team.map((h,i)=>({h,slot:slots[i]})).sort((a,b)=>b.slot-a.slot).map(x=>x.h); const cur = G.team[UI.hi]; G.team.splice(0,G.team.length,...ordered); UI.hi = Math.max(0, G.team.indexOf(cur)); UI.formationSel = null; buildArena(); buildEnemy(); G.save.save(); hideOv(); ACT.nav({s:'abyss'}); },
  nav: d => { if (d.s === 'abyss' && window.EXPEDITION_PAUSED) { window.EXPEDITION_PAUSED = false; UI.fresh = false; GameRefs.campHold = false; UI.defeatNote = null; GameRefs.runLoot = []; } goto(d.s); },
  pauseCombat: () => { GameRefs.combatPaused = !GameRefs.combatPaused; renderPause(); toast(GameRefs.combatPaused ? '⏸ Combate pausado' : '▶ Combate retomado', GameRefs.combatPaused ? '' : 'good'); },
  speed: () => { const bestDepth = Number(G && G.abyss && G.abyss.best || 1); const unlocked = bestDepth >= 21 ? 4 : bestDepth >= 11 ? 3 : 2; const current = Math.max(0, SPEED_LEVELS.indexOf(window.GAME_SPEED)); const next = (current + 1) % unlocked; window.GAME_SPEED = SPEED_LEVELS[next]; $('spd').textContent = SPEED_LABELS[next]; },
  skill: d => G.skillSystem.castSkill(G.team[+d.i]),
  upg: d => { if (CampService.upgrade(d.id, G.camp)) { recalcAll(); toast(BLD[d.id][1] + ' → Lv' + G.camp.buildingLevels[d.id], 'good'); } renderCamp(); },
  claim: () => { if (G.campController.claimQuest()) toast('Quest concluída!', 'good'); renderCamp(); },
  pull: d => { const r = GachaService.pull(BANNER_DEFINITIONS[0], G.camp, G.inventory, +d.n); if (!r) return toast('Ouro insuficiente'); UI.pulls = r.map(x => x.type === 'card' ? '🃏' + CardService.def(x.item).name + ' ' + x.item.stars + '★' : '🐾' + PetService.def(x.item).name + ' ' + x.item.rarityLabel).slice(0, 4); if (r.length > 4) UI.pulls.push('+' + (r.length - 4)); toast('Gacha: ' + r.length + ' resultado(s)', 'epic'); renderCamp(); },
  rebirth: () => { askConfirm('Rebirth: reseta profundidade e nível dos heróis. Continuar?', () => { if (PrestigeService.rebirth(G.prestige, G.abyss, G.team)) { recalcAll(); G.enterRoom(); toast('Rebirth realizado!', 'epic'); renderCamp(); } }, 'Rebirth'); },
  save: () => { G.save.save(); toast('Save gravado', 'good'); },
  wipe: () => { askConfirm('Apagar todo o progresso?', () => { window.__noSave = true; try { localStorage.removeItem(SAVE_SLOTS[UI.slot || 0]); } catch (e) {} location.reload(); }, 'Apagar'); },
  hsel: d => { UI.hi = +d.i; renderHeroes(); },
  ctab: d => { UI.ct = d.k; renderHeroes(); },
  eqItem: d => { G.team[UI.hi].equipItem(G.inventory.findById(d.id)); renderHeroes(); },
  eqGem: d => { const h = G.team[UI.hi], i = h.gemSlots.findIndex(g => !g); if (i < 0) return toast('Sem sockets livres'); GemService.equip(h, G.inventory.findGemById(d.id), i); h.recalculate(); renderHeroes(); },
  unsock: d => { const h = G.team[UI.hi]; GemService.remove(h, +d.i); h.recalculate(); renderHeroes(); },
  mix: d => { const a = G.inventory.findGemById(d.a), b = G.inventory.findGemById(d.b), m = GemService.combine(a, b); G.inventory.removeGem(a.id); G.inventory.removeGem(b.id); G.inventory.addGem(m); toast('Gemas combinadas: Lv' + m.level, 'good'); renderHeroes(); },
  mixCard: d => { const a = G.inventory.findCardById(d.a), b = G.inventory.findCardById(d.b), eq = eqSet(); if (!CardService.canCombine(a, b) || eq.has(a.id) || eq.has(b.id)) return toast('Essas cartas não podem ser combinadas'); const m = CardService.combine(a, b); G.inventory.removeCard(a.id); G.inventory.removeCard(b.id); G.inventory.addCard(m); G.save.save(); toast(`Cartas combinadas: ${CardService.def(m).name} ${'★'.repeat(m.stars)} Lv${m.level}`, 'good'); renderHeroes(); },
  mixAllCards: () => { const p = cardMergeAll(false); if (!p.pairs) return toast('Nenhuma combinação possível'); askConfirm(`Combinar todas as cartas possíveis?\n\n${p.pairs} ${p.pairs === 1 ? 'combinação' : 'combinações'}: ${p.used} cartas viram ${p.made.length}.\nCartas equipadas não são usadas.`, () => { const r = cardMergeAll(true); G.save.save(); toast(`🃏 ${r.pairs} combinações: ${r.used} cartas → ${r.made.length}`, 'good'); renderHeroes(); }, 'Combinar'); },
  eqCard: d => { CardService.equip(G.team[UI.hi], G.inventory.findCardById(d.id)); renderHeroes(); },
  upCard: d => { const c = G.inventory.findCardById(d.id); if (!c) return toast('Carta não encontrada no inventário'); const cost = cardUpgradeCost(c), max = CardService.maxLevel(c); if (c.level >= max) return toast('Carta já está no nível máximo 10'); if (!CurrencyService.hasCurrency(G.camp, 'gold', cost)) return toast(`Moedas insuficientes: precisa de 🪙 ${cost}`); askConfirm(`Aprimorar ${CardService.def(c).name} para Lv${c.level + 1}/${max}?\nBônus atual: ${cardUpgradeSummary(c)}\nCusto: 🪙 ${cost} moedas.`, () => { if (!CurrencyService.removeCurrency(G.camp, 'gold', cost)) return toast('Não foi possível cobrar as moedas; saldo preservado'); if (!CardService.upgrade(c)) { CurrencyService.addCurrency(G.camp, 'gold', cost); return toast('Não foi possível aprimorar a carta; moedas devolvidas'); } G.save.save(); recalcAll(); renderHeroes(); renderCamp(); toast(`🪙 -${cost} moedas · ${CardService.def(c).name} agora está Lv${c.level}/10 · ${cardUpgradeSummary(c)}`, 'good'); }, 'Aprimorar'); },
  pAct: d => { PetService.setActive(G.petRoster, d.id); recalcAll(); renderHeroes(); },
  pBench: d => { PetService.addToBench(G.petRoster, d.id); recalcAll(); renderHeroes(); },
  pUp: d => { const pet = G.inventory.findPetById(d.id), cost = PetService.upgradeFoodCost(pet); if (!pet || pet.level >= PetService.maxLevel(pet)) return toast('Pet no limite de nível'); if (G.camp.food < cost) return toast(`Comida insuficiente: precisa de 🍖 ${cost}`); if (PetService.upgrade(pet, G.camp)) { G.save.save(); recalcAll(); renderHeroes(); toast(`Pet evoluiu para Lv ${pet.level}: 🍖 -${cost}`, 'good'); } },
  weaponEvoFromHero: d => { UI.weaponEvolution = WeaponEvolutionSelection.create(); UI.weaponEvolution.mainWeaponId = d.id; goto('weapons'); },
  weaponEvoMain: d => { const sel = UI.weaponEvolution; if (!WeaponEvolutionSelection.selectMain(sel, d.id)) return toast('Essa arma já está marcada como material'); renderWeaponEvolution(); },
  weaponEvoMat: d => { const sel = UI.weaponEvolution; if (sel.materialWeaponIds.includes(d.id)) WeaponEvolutionSelection.removeMaterial(sel, d.id); else if (!WeaponEvolutionSelection.addMaterial(sel, d.id)) return toast('Não é possível selecionar essa arma como material'); renderWeaponEvolution(); },
  weaponEvoReset: () => { UI.weaponEvolution = WeaponEvolutionSelection.create(); renderWeaponEvolution(); },
  weaponLevelItem: d => { const w = (G.inventory?.items || []).find(item => String(item.id) === String(d.id)); if (!w || !['weapon','armor'].includes(w.slot)) return toast('Não foi possível localizar essa arma/escudo no inventário.'); const limit = weaponMaxLevel(w), current = Math.max(1, Number(w.level) || 1), cost = weaponForgeCost(w); const available = Math.max(0, Number(G.camp?.materials) || 0); if (current >= limit) return toast(`Equipamento já está no nível máximo ${limit}.`); if (available < cost) return toast(`Material da Forja insuficiente: precisa de ⚒ ${cost}; disponível: ⚒ ${available}.`); const oldLevel = w.level, oldBonus = w.upgradeBonus, oldMaterials = G.camp.materials; if (!CurrencyService.removeCurrency(G.camp, 'materials', cost)) return toast(`Material da Forja insuficiente: precisa de ⚒ ${cost}; disponível: ⚒ ${available}.`); w.level = current + 1; w.upgradeBonus = Math.max(0, Number(w.upgradeBonus) || 0) + 0.03; try { if (typeof G.save?.save === 'function') G.save.save(); } catch (err) { G.camp.currencies.materials = oldMaterials; w.level = oldLevel; w.upgradeBonus = oldBonus; console.error('weaponLevelItem save failed', err); return toast('Não foi possível salvar a evolução; nenhum material foi consumido. Tente novamente.'); } try { if (typeof recalcAll === 'function') recalcAll(); } catch (err) { console.error('Recalcular atributos após evolução', err); } try { if (UI.screen === 'weapons') renderWeaponEvolution(); else if (UI.screen === 'heroes') renderHeroes(); else if (UI.screen === 'camp') renderCamp(); else if (typeof renderInventory === 'function') renderInventory(); } catch (err) { console.error('Atualizar interface após evolução', err); } toast(`⚒ -${cost} materiais · ${w.name}: Lv${w.level}/${limit} · bônus acumulado +${Math.round(w.upgradeBonus*100)}%`, 'good'); },
  weaponLevelUp: () => { try { const sel = UI.weaponEvolution, w = sel?.mainWeaponId ? G.inventory.findById(String(sel.mainWeaponId)) : null; if (!w || !['weapon','armor'].includes(w.slot)) return toast('Selecione uma arma ou escudo principal.'); const limit = weaponMaxLevel(w), current = Math.max(1, Number(w.level) || 1), cost = weaponForgeCost(w); if (current >= limit) return toast(`Equipamento no nível máximo ${limit}; agora pode evoluir o rank.`); if ((Number(G.camp.materials) || 0) < cost) return toast(`Material da Forja insuficiente: precisa de ⚒ ${cost}.`); CurrencyService.removeCurrency(G.camp, 'materials', cost); w.level = current + 1; w.upgradeBonus = Math.max(0, Number(w.upgradeBonus) || 0) + 0.03; if (typeof G.save?.save === 'function') G.save.save(); if (typeof recalcAll === 'function') recalcAll(); renderWeaponEvolution(); toast(`⚒ -${cost} materiais · ${w.name} subiu para Lv${w.level}/${limit} · bônus acumulado +${Math.round(w.upgradeBonus*100)}%`, 'good'); } catch (err) { console.error('weaponLevelUp', err); toast('Erro ao aprimorar o equipamento. Verifique o inventário e tente novamente.'); } },
  weaponEvoConfirm: () => { const sel = UI.weaponEvolution; if (!WeaponEvolutionSelection.isComplete(sel)) return toast('Selecione 1 arma principal e exatamente 5 armas materiais'); const main = G.inventory.findById(sel.mainWeaponId); const mats = sel.materialWeaponIds.map(id => G.inventory.findById(id)); if (!main || !['weapon','armor'].includes(main.slot) || mats.some(w => !w || w.slot !== main.slot) || weaponStage(main) >= WEAPON_EVOLUTION_STAGE_LIMITS.length) return toast('Seleção inválida: escolha 5 materiais do mesmo tipo ou confira o estágio máximo'); if ((main.level || 1) < weaponMaxLevel(main)) return toast(`Aprimore a arma até Lv${weaponMaxLevel(main)} antes de evoluir`); const equipped = new Set(); G.team.forEach(h => { if (h.equipment.weapon) equipped.add(h.equipment.weapon.id); if (h.equipment.armor) equipped.add(h.equipment.armor.id); }); if (mats.some(w => equipped.has(w.id))) return toast('Remova as armas materiais dos equipamentos antes de evoluir'); const beforeStage = weaponStage(main), rarity = main.rarityLabel || main.rarityId; sel.materialWeaponIds.forEach(id => G.inventory.removeItem(id)); main.evolutionStage = beforeStage + 1; main.level = 1; main.levelLimit = WEAPON_EVOLUTION_STAGE_LIMITS[beforeStage]; UI.weaponEvolution = WeaponEvolutionSelection.create(); G.save.save(); renderWeaponEvolution(); toast(`${main.slot === 'armor' ? 'Escudo' : 'Arma'} evoluiu para o rank ${weaponRankName(main)} (estágio ${main.evolutionStage}) · -5 materiais consumidos · raridade preservada.`, 'good'); showEvolutionCelebration(main, beforeStage); },
  petEvoMain: d => { const sel = UI.petEvolution; if (!PetEvolutionSelection.selectMain(sel, d.id)) return toast('Esse pet já está marcado como material'); renderPetEvolution(); },
  petEvoMat: d => { const sel = UI.petEvolution; if (sel.materialPetIds.includes(d.id)) PetEvolutionSelection.removeMaterial(sel, d.id); else if (!PetEvolutionSelection.addMaterial(sel, d.id)) return toast('Não é possível selecionar esse material'); renderPetEvolution(); },
  petEvoReset: () => { UI.petEvolution = PetEvolutionSelection.create(); renderPetEvolution(); },
  petEvoConfirm: () => { const sel = UI.petEvolution; if (!PetEvolutionSelection.isComplete(sel)) return toast('Selecione 1 principal e exatamente 5 materiais'); const main = G.inventory.findPetById(sel.mainPetId); if (!main || PetService.evolutionStage(main) >= PET_EVOLUTION_STAGE_LIMITS.length) return toast('Pet já está no estágio máximo'); const beforeStage = PetService.evolutionStage(main), beforeRarity = main.rarityLabel || main.rarityId; askConfirm('Sacrificar os 5 pets selecionados para evoluir este pet? A raridade do pet principal será preservada.' + `\n\nPrincipal: ${PetService.def(main).name} (${beforeRarity})\nResultado: Estágio ${beforeStage + 1}, nível 1/${PET_EVOLUTION_STAGE_LIMITS[beforeStage]}.`, () => { const ok = PetEvolutionService.confirmAndEvolve(sel, G.inventory, () => true); if (!ok) return toast('Evolução cancelada ou seleção inválida'); G.save.save(); recalcAll(); toast(`Pet evoluiu para estágio ${main.evolutionStage}; raridade preservada.`, 'good'); renderCamp(); }, 'Evoluir'); },
  tal: d => { G.team[UI.hi].spendTalent(d.n); renderHeroes(); },
  closeOv: () => hideOv(),
  petSalvageOpen: () => { UI.petSalvageSel = {}; renderPetSalvage(); },
  petSalvageToggle: d => { UI.petSalvageSel = UI.petSalvageSel || {}; if (UI.petSalvageSel[d.id]) delete UI.petSalvageSel[d.id]; else UI.petSalvageSel[d.id] = true; renderPetSalvage(); },
  petSalvageFilter: d => { const sel = UI.petSalvageSel = UI.petSalvageSel || {}, grp = petSalvageEligible().filter(p => p.rarityId === d.r && !petInvested(p)), all = grp.length && grp.every(p => sel[p.id]); grp.forEach(p => { if (all) delete sel[p.id]; else sel[p.id] = true; }); renderPetSalvage(); },
  petSalvageClear: () => { UI.petSalvageSel = {}; renderPetSalvage(); },
  petSalvageConfirm: () => { const picked = petSalvageEligible().filter(p => UI.petSalvageSel && UI.petSalvageSel[p.id]); if (!picked.length) return toast('Nenhum pet selecionado'); const total = picked.reduce((s, p) => s + petSalvageValue(p), 0), inv = picked.filter(petInvested).length; askConfirm(`Desmontar ${picked.length} ${picked.length === 1 ? 'pet' : 'pets'} por ✨ ${total} de Essência de Pet?${inv ? `\n\n⚠ ${inv} ${inv === 1 ? 'já foi treinado ou evoluído' : 'já foram treinados ou evoluídos'}: o progresso será perdido.` : ''}\n\nEsta ação não pode ser desfeita.`, () => petSalvageDo(picked.map(p => p.id)), 'Desmontar'); },
  salvageOpen: () => { UI.salvageSel = {}; renderSalvage(); },
  salvageToggle: d => { UI.salvageSel = UI.salvageSel || {}; if (UI.salvageSel[d.id]) delete UI.salvageSel[d.id]; else UI.salvageSel[d.id] = true; renderSalvage(); },
  salvageFilter: d => { const sel = UI.salvageSel = UI.salvageSel || {}, grp = salvageEligible().filter(i => i.rarityId === d.r && !isInvested(i)), all = grp.length && grp.every(i => sel[i.id]); grp.forEach(i => { if (all) delete sel[i.id]; else sel[i.id] = true; }); renderSalvage(); },
  salvageClear: () => { UI.salvageSel = {}; renderSalvage(); },
  salvageConfirm: () => { const picked = salvageEligible().filter(i => UI.salvageSel && UI.salvageSel[i.id]); if (!picked.length) return toast('Nenhum item selecionado'); const total = picked.reduce((s, i) => s + salvageValue(i), 0), inv = picked.filter(isInvested).length; askConfirm(`Desmontar ${picked.length} ${picked.length === 1 ? 'item' : 'itens'} por ⚒ ${total} de material da Forja?${inv ? `\n\n⚠ ${inv} ${inv === 1 ? 'já foi aprimorado ou evoluído' : 'já foram aprimorados ou evoluídos'}: o aprimoramento será perdido.` : ''}\n\nEsta ação não pode ser desfeita.`, () => salvageDo(picked.map(i => i.id)), 'Desmontar'); },
  itemInfo: d => showItemInfo(G.team[UI.hi], d.k),
  confirmYes: () => { const f = UI.pendingConfirm; UI.pendingConfirm = null; hideOv(); if (f) f(); },
  confirmNo: () => { UI.pendingConfirm = null; hideOv(); },
  collect: () => { const r = CampService.collect(G.camp); toast(r.materials + r.food >= 1 ? `Coletado: ⚒ ${fmt(r.materials)} · 🍖 ${fmt(r.food)}` : 'Storage cheio — melhore o Storage', r.materials + r.food >= 1 ? 'good' : ''); renderCamp(); },
  autoToggle: () => { GameRefs.autoBattle = !GameRefs.autoBattle; renderAuto(); toast(GameRefs.autoBattle ? '⚡ Batalha automática' : '🎮 Batalha manual'); },
  saveGame: () => { if (G && G.save && typeof G.save.save === 'function') { G.save.save(); toast('Jogo salvo.', 'good'); } else toast('Não foi possível salvar o jogo.'); },
  stages: () => showStages(),
  stageNext: () => { UI.stageAutoAdvance = false; if (UI.stageClear && UI.stageClear.next) ACT.pickDepth({ n: UI.stageClear.next }); },
  stageRepeat: () => { if (UI.stageClear) ACT.pickDepth({ n: UI.stageClear.depth }); },
  stageCamp: () => { UI.stageAutoAdvance = false; UI.stageClear = null; GameRefs.runLoot = []; G.save.save(); hideOv(); goto('camp'); },
  pickDepth: d => { const n = +d.n, A = G.abyss; if (!A.selectDepth(n)) return toast('Fase ainda não alcançada'); UI.stageAutoAdvance = false; startFreshEncounter(); window.EXPEDITION_PAUSED = false; UI.fresh = false; GameRefs.campHold = false; UI.defeatNote = null; UI.stageClear = null; if (UI.onEnemySpawn) UI.onEnemySpawn(); hideOv(); toast(A.farm ? `🎯 Treinando Prof. ${n}` : `⚔ Fronteira · Prof. ${n}`, 'good'); goto('abyss'); },
  dbg: d => { const c = G.camp, A = G.abyss; ({ gold: () => CurrencyService.addCurrency(c, 'gold', 1000), dia: () => CurrencyService.addCurrency(c, 'diamonds', 1000), xp: () => G.team.forEach(h => h.gainExperience(500)), heal: () => G.team.forEach(h => { h.currentHP = h.finalStats.hp; }), cd: () => { for (const k in G.skillSystem.cooldowns) G.skillSystem.cooldowns[k] = 0; }, god: () => { GameRefs.godMode = !GameRefs.godMode; }, depth: () => { const n = parseInt(prompt('Profundidade (1-' + ABYSS_CONFIG.maxDepth + '):', A.depth), 10); if (n >= 1 && n <= ABYSS_CONFIG.maxDepth) { A.depth = n; A.kills = 0; A.bossReady = false; A.best = Math.max(A.best, n); A.farm = n < A.best; setEncounter(G.encounter, spawnCommonEncounter(n)); } }, boss: () => {
  const bosses = [{ id: 'base', nome: BOSS_DEFINITION.name }];
  (window.NOVAS_FASES || []).forEach(f => { if (f.boss) bosses.push({ id: f.id, nome: f.boss.nome }); });
  let menuText = "Escolha o Boss (1 a " + bosses.length + "):\n";
  bosses.forEach((b, i) => menuText += `${i + 1} - ${b.nome}\n`);
  const choiceStr = prompt(menuText, "1");
  if (!choiceStr) return;
  const choice = parseInt(choiceStr, 10);
  if (choice >= 1 && choice <= bosses.length) {
    const selected = bosses[choice - 1];
    let b;
    if (selected.id === 'base') {
      b = new EnemyInstance(BOSS_DEFINITION);
      b.stats = scaledStats(BOSS_DEFINITION.stats, A.depth, true);
      b.currentHP = b.stats.hp;
      b.isBoss = true;
    } else {
      const customFase = window.NOVAS_FASES.find(f => f.id === selected.id);
      b = new EnemyInstance({ name: customFase.boss.nome, stats: { hp: 100, atk: 10, def: 5, atkSpeed: 0.8 } });
      b.stats = scaledStats(b.stats, customFase.id, true);
      b.stats.hp = Math.round(b.stats.hp * customFase.boss.hpMult);
      b.stats.atk = Math.round(b.stats.atk * customFase.boss.atkMult);
      b.currentHP = b.stats.hp;
      b.isBoss = true;
      if (customFase.boss.sprite) b.customSprite = customFase.boss.sprite;
    }
    setEncounter(G.encounter, [b]);
    if (UI.onEnemySpawn) UI.onEnemySpawn();
    buildEnemy();
    toast(`Boss invocado: ${b.name}`, 'epic');
  }
}, eq: () => G.inventory.addItem(generateItem(A.depth, Math.random() < .5 ? 'weapon' : 'armor')), card: () => G.inventory.addCard(generateCard()), gem: () => G.inventory.addGem(generateGem()), pet: () => G.inventory.addPet(generatePet()) })[d.k](); renderCamp(); }
};
document.addEventListener('pointerdown', () => { UI.touch = Date.now(); });
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && ACT[b.dataset.act]) ACT[b.dataset.act](b.dataset); });

function askConfirm(message, onYes, yesLabel) {
  UI.pendingConfirm = onYes;
  const txt = String(message).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  showOv(`<h2 class="d">Confirmar</h2><div class="dim" style="white-space:pre-line;margin-bottom:12px">${txt}</div><div class="row" style="gap:8px"><button class="btn sec" data-act="confirmNo" style="flex:1;padding:11px">Cancelar</button><button class="btn pri" data-act="confirmYes" style="flex:1;padding:11px">${yesLabel || 'Confirmar'}</button></div>`);
}
function fmtAffixValue(a, mult) { const v = a.value * mult, pctLike = a.type === 'percent' || a.stat === 'critRate' || a.stat === 'critDmg'; return pctLike ? `+${(v * 100).toFixed(1)}%` : `+${v.toFixed(v >= 10 ? 1 : 2)}`; }
function showItemInfo(h, kind) {
  const close = '<button class="btn pri" data-act="closeOv" style="width:100%;padding:11px;margin-top:12px">Fechar</button>';
  if (kind === 'card') { const cd = h.card; if (!cd) return; const mx = CardService.maxLevel(cd); return showOv(`<h2 class="d">🃏 ${CardService.def(cd).name}</h2><div class="dim" style="margin-bottom:8px">${'★'.repeat(cd.stars || 1)} · Nível ${cd.level}/${mx}</div><div class="panel">${cardUpgradeSummary(cd)}</div><div class="dim" style="margin-top:8px">${cd.level < mx ? `Próximo nível: 🪙 ${fmt(cardUpgradeCost(cd))} (você tem 🪙 ${fmt(G.camp.gold)})` : 'Nível máximo.'}</div>${close}`); }
  const it = h.equipment[kind]; if (!it) return;
  const up = Math.max(0, Number(it.upgradeBonus) || 0), mult = 1 + up, lv = it.level || 1, mx = weaponMaxLevel(it);
  const rows = (it.affixes || []).map(a => `<div class="row" style="padding:3px 0"><div class="grow">${a.label}</div><b>${fmtAffixValue(a, mult)}</b>${up > 0 ? `<span class="dim" style="margin-left:6px">(base ${fmtAffixValue(a, 1)})</span>` : ''}</div>`).join('') || '<div class="dim">Sem atributos.</div>';
  showOv(`<h2 class="d">${kind === 'weapon' ? '🗡' : '🛡'} ${it.name}</h2><div class="dim" style="margin-bottom:6px">${it.rarityLabel || it.rarityId} · ${kind === 'weapon' ? 'Arma' : 'Escudo/Armadura'}</div><div style="margin-bottom:8px">${weaponRankBadge(it)} <span class="dim">${weaponRankNote(it)}</span></div><div class="panel">Nível ${lv}/${mx} · Aprimoramento da Forja: +${Math.round(up * 100)}%</div><div class="sec-t">Atributos</div>${rows}<div class="dim" style="margin-top:8px">${lv < mx ? `Próximo nível: ⚒ ${fmt(weaponForgeCost(it))} (você tem ⚒ ${fmt(G.camp.materials)})` : 'Nível máximo do estágio: pronto para evoluir o rank.'}</div>${close}`);
}
const SALVAGE_YIELD = { common: 2, rare: 5, epic: 12, legendary: 30 };
const SALVAGE_LABEL = { common: 'Comuns', rare: 'Raros', epic: 'Épicos' };
const salvageValue = it => SALVAGE_YIELD[it.rarityId] || 0;
const isInvested = it => (it.level || 1) > 1 || (it.evolutionStage || 1) > 1 || Number(it.upgradeBonus) > 0;
function salvageEligible() { const eq = new Set(); G.team.forEach(h => { if (h.equipment.weapon) eq.add(h.equipment.weapon.id); if (h.equipment.armor) eq.add(h.equipment.armor.id); }); return G.inventory.items.filter(i => (i.slot === 'weapon' || i.slot === 'armor') && !eq.has(i.id)); }
function renderSalvage() {
  const list = salvageEligible().sort(itemCmp), sel = UI.salvageSel = UI.salvageSel || {}, ids = new Set(list.map(i => String(i.id)));
  Object.keys(sel).forEach(k => { if (!ids.has(k)) delete sel[k]; });
  const picked = list.filter(i => sel[i.id]), total = picked.reduce((s, i) => s + salvageValue(i), 0);
  const rows = list.map(i => `<div class="li dsr ${sel[i.id] ? 'on' : ''}" data-act="salvageToggle" data-id="${i.id}"><div class="ic ${rc(i.rarityId)}">${i.slot === 'weapon' ? '🗡' : '🛡'}</div><div class="grow"><b>${i.name}</b><div class="dim" style="font-size:10px">${i.rarityLabel || i.rarityId} · ⚡${itemPowerNum(i)}${isInvested(i) ? ` · <span style="color:var(--gold)">aprimorado: Lv${i.level || 1} · Rank ${weaponRankName(i)}</span>` : ''}</div></div><b>${sel[i.id] ? '☑' : '☐'} ⚒ ${salvageValue(i)}</b></div>`).join('') || '<div class="dim" style="padding:10px 0">Nenhum item para desmontar (os equipados ficam protegidos).</div>';
  const cnt = r => list.filter(i => i.rarityId === r && !isInvested(i)).length, dl = document.querySelector('.dlist'), top = dl ? dl.scrollTop : 0;
  showOv(`<h2 class="d" style="font-size:18px">♻ Desmontar itens</h2><div class="dim">Troque armas e armaduras não equipadas por material da Forja. Itens equipados não aparecem. Do mais fraco ao mais forte.</div><div class="row" style="gap:6px;margin:8px 0;flex-wrap:wrap">${['common', 'rare', 'epic'].map(r => `<button class="btn sm sec" data-act="salvageFilter" data-r="${r}">${SALVAGE_LABEL[r]} (${cnt(r)})</button>`).join('')}<button class="btn sm sec" data-act="salvageClear">Limpar</button></div><div class="dlist">${rows}</div><div class="dim" style="margin-top:8px">Selecionados: <b>${picked.length}</b> · ⚒ <b>+${total}</b> (você tem ⚒ ${fmt(G.camp.materials)})</div><div class="row" style="margin-top:10px"><button class="btn sec grow" data-act="closeOv">Fechar</button><button class="btn pri grow" data-act="salvageConfirm" ${picked.length ? '' : 'disabled'}>Desmontar ⚒ +${total}</button></div>`);
  const nl = document.querySelector('.dlist'); if (nl) nl.scrollTop = top;
}
function salvageDo(ids) {
  const set = new Set(ids.map(String)), elig = salvageEligible().filter(i => set.has(String(i.id)));
  if (!elig.length) return toast('Nada para desmontar (itens equipados ou já removidos).');
  const total = elig.reduce((s, i) => s + salvageValue(i), 0), snapItems = G.inventory.items.slice(), snapMat = G.camp.currencies.materials;
  try { elig.forEach(i => G.inventory.removeItem(i.id)); CurrencyService.addCurrency(G.camp, 'materials', total); } catch (e) { G.inventory.items = snapItems; G.camp.currencies.materials = snapMat; return toast('Não foi possível desmontar: nada foi alterado.'); }
  const ev = UI.weaponEvolution, gone = new Set(elig.map(i => String(i.id)));
  if (ev) { if (ev.mainWeaponId && gone.has(String(ev.mainWeaponId))) ev.mainWeaponId = null; ev.materialWeaponIds = ev.materialWeaponIds.filter(id => !gone.has(String(id))); }
  UI.salvageSel = {}; G.save.save(); toast(`♻ ${elig.length} ${elig.length === 1 ? 'item desmontado' : 'itens desmontados'}: +⚒ ${total} de material da Forja`, 'good'); if (UI.screen === 'heroes') renderHeroes(); if (UI.screen === 'weapons') renderWeaponEvolution();
}
const PET_SALVAGE_YIELD = { common: 1, rare: 3, epic: 8, legendary: 20 };
const petSalvageValue = p => PET_SALVAGE_YIELD[p.rarityId] || 0;
const petInvested = p => (p.level || 1) > 1 || (p.evolutionStage || 1) > 1;
function petSalvageEligible() { const r = G.petRoster; return G.inventory.pets.filter(p => p.id !== r.activeId && !r.benchIds.includes(p.id)); }
function renderPetSalvage() {
  const list = petSalvageEligible().sort((a, b) => ((RARITY_ORD[a.rarityId] || 0) - (RARITY_ORD[b.rarityId] || 0)) || ((a.evolutionStage || 1) - (b.evolutionStage || 1)) || ((a.level || 1) - (b.level || 1)) || String(PetService.def(a).name).localeCompare(String(PetService.def(b).name)));
  const sel = UI.petSalvageSel = UI.petSalvageSel || {}, ids = new Set(list.map(p => String(p.id)));
  Object.keys(sel).forEach(k => { if (!ids.has(k)) delete sel[k]; });
  const picked = list.filter(p => sel[p.id]), total = picked.reduce((s, p) => s + petSalvageValue(p), 0);
  const rows = list.map(p => `<div class="li dsr ${sel[p.id] ? 'on' : ''}" data-act="petSalvageToggle" data-id="${p.id}"><div class="ic ${rc(p.rarityId)}">🐾</div><div class="grow"><b>${PetService.def(p).name}</b><div class="dim" style="font-size:10px">${p.rarityLabel || p.rarityId} · Lv${p.level || 1}/${p.levelLimit || 10} · Estágio ${p.evolutionStage || 1}${petInvested(p) ? ' · <span style="color:var(--gold)">já treinado/evoluído</span>' : ''}</div></div><b>${sel[p.id] ? '☑' : '☐'} ✨ ${petSalvageValue(p)}</b></div>`).join('') || '<div class="dim" style="padding:10px 0">Nenhum pet livre para desmontar (o ativo e os da reserva ficam protegidos).</div>';
  const cnt = r => list.filter(p => p.rarityId === r && !petInvested(p)).length, dl = document.querySelector('.dlist'), top = dl ? dl.scrollTop : 0;
  showOv(`<h2 class="d" style="font-size:18px">♻ Desmontar pets</h2><div class="dim">Troque pets livres por <b>Essência de Pet</b>, guardada para a evolução futura. O pet ativo e os da reserva não aparecem. Do mais fraco ao mais forte.</div><div class="row" style="gap:6px;margin:8px 0;flex-wrap:wrap">${['common', 'rare', 'epic'].map(r => `<button class="btn sm sec" data-act="petSalvageFilter" data-r="${r}">${SALVAGE_LABEL[r]} (${cnt(r)})</button>`).join('')}<button class="btn sm sec" data-act="petSalvageClear">Limpar</button></div><div class="dlist">${rows}</div><div class="dim" style="margin-top:8px">Selecionados: <b>${picked.length}</b> · ✨ <b>+${total}</b> (você tem ✨ ${fmt(CurrencyService.getBalance(G.camp, 'petEssence'))})</div><div class="row" style="margin-top:10px"><button class="btn sec grow" data-act="closeOv">Fechar</button><button class="btn pri grow" data-act="petSalvageConfirm" ${picked.length ? '' : 'disabled'}>Desmontar ✨ +${total}</button></div>`);
  const nl = document.querySelector('.dlist'); if (nl) nl.scrollTop = top;
}
function petSalvageDo(ids) {
  const set = new Set(ids.map(String)), elig = petSalvageEligible().filter(p => set.has(String(p.id)));
  if (!elig.length) return toast('Nada para desmontar (pets ativos, na reserva ou já removidos).');
  const total = elig.reduce((s, p) => s + petSalvageValue(p), 0), snapPets = G.inventory.pets.slice(), snapBal = G.camp.currencies.petEssence;
  try { elig.forEach(p => G.inventory.removePet(p.id)); CurrencyService.addCurrency(G.camp, 'petEssence', total); } catch (e) { G.inventory.pets = snapPets; G.camp.currencies.petEssence = snapBal; return toast('Não foi possível desmontar: nada foi alterado.'); }
  const ev = UI.petEvolution, gone = new Set(elig.map(p => String(p.id)));
  if (ev) { if (ev.mainPetId && gone.has(String(ev.mainPetId))) ev.mainPetId = null; ev.materialPetIds = ev.materialPetIds.filter(id => !gone.has(String(id))); }
  UI.petSalvageSel = {}; G.save.save(); toast(`♻ ${elig.length} ${elig.length === 1 ? 'pet desmontado' : 'pets desmontados'}: +✨ ${total} Essência de Pet`, 'good'); if (UI.screen === 'heroes') renderHeroes(); if (UI.screen === 'camp') renderCamp();
}
function offlineModal(o) {
  showOv(`<h2 class="d">Expedição Concluída</h2><div class="dim">Tempo offline: ${Math.round(o.elapsedSec / 60)} min${o.depthTo > o.depthFrom ? ` · Prof. ${o.depthFrom} → ${o.depthTo}` : ''}</div>
  <div class="rg"><div class="rt">🪙<b>+${fmt(o.goldGained)}</b>Ouro</div><div class="rt">✨<b>+${fmt(o.xpGained)}</b>XP/herói</div><div class="rt">⚒<b>+${fmt(o.materialsGained)}</b>Materiais</div><div class="rt">🍖<b>+${fmt(o.foodGained)}</b>Comida</div></div>
  ${o.anyLevelUp ? '<div class="dim" style="margin-bottom:8px">★ Heróis subiram de nível</div>' : ''}<button class="btn pri" data-act="closeOv" style="width:100%;padding:11px">Continuar</button>`);
}
/* =========================================================
   SETUP DO MOTOR E INICIALIZAÇÃO
   ========================================================= */
function setupGame(mode, slot) {
  AnalyticsService.init();
  EventBus.emit("OnPlayerLogin", { timestamp: Date.now() });
  window.addEventListener("beforeunload", () => EventBus.emit("OnPlayerLogout", { timestamp: Date.now() }));

  const loop = new GameLoopController();
  const save = new SaveManager(SAVE_SLOTS[slot || 0]);
  ServiceLocator.register("GameLoop", loop);
  ServiceLocator.register("SaveManager", save);

  const playerProfile = new PlayerProfileSystem();
  loop.registerSystem(playerProfile);
  save.register(playerProfile);

  const abyss = new AbyssProgress();
  save.register(abyss);
  const stageStars = new StageStarsSystem();
  save.register(stageStars);
  const inventory = new InventorySystem();
  save.register(inventory);
  const petRoster = { activeId: null, benchIds: [] };
  GameRefs.inventory = inventory;
  GameRefs.petRoster = petRoster;
  const camp = new CampState();
  save.register(camp);
  GameRefs.camp = camp;
  const prestige = new PrestigeState();
  save.register(prestige);
  GameRefs.prestige = prestige;

  const team = [
    new HeroInstance("warrior"),
    new HeroInstance("archer"),
    new HeroInstance("mage")
  ];
  const teamSave = new TeamSaveSystem(team, inventory);
  save.register(teamSave);
  const petSave = new PetSaveSystem(petRoster);
  save.register(petSave);
  save.register(new GachaSaveSystem());

  const encounter = { current: null, enemies: [], completionProcessed: false };
  setEncounter(encounter, spawnCommonEncounter(abyss.depth));
  const LOOT_CHANCE = 0.4;

  function beginEncounter(enemies) {
    setEncounter(encounter, enemies);
    const lead = encounter.current;
    EventBus.emit("OnCombatStarted", {
      depth: abyss.depth, enemy: lead.name, enemyCount: enemies.length, isBoss: !!lead.isBoss
    });
  }

  function resolveNonCombatRoom(type) {
    Logger.event(`Sala: ${ROOM_LABELS[type]}`);
    switch (type) {
      case "empty": break;
      case "treasure": {
        const item = generateItem(abyss.depth, Math.random() < 0.5 ? "weapon" : "armor");
        inventory.addItem(item); trackRunLoot('item', item);
        Logger.event(`Baú: ${item.name}`);
        EventBus.emit("OnItemDropped", { kind: "equipment", name: item.name });
        break;
      }
      case "shrine": {
        const hero = team[Math.floor(Math.random() * team.length)];
        StatusEffectService.apply(hero, "empower", { duration: 30 });
        Logger.event(`Santuário abençoou ${hero.name} (+ATK temporário)`);
        break;
      }
      case "resource": {
        const goldAmt = 15 + Math.floor(abyss.depth * 2);
        CurrencyService.addCurrency(camp, "gold", goldAmt);
        Logger.event(`Recursos encontrados: +${goldAmt}g`);
        break;
      }
      case "trap": {
        const hero = team[Math.floor(Math.random() * team.length)];
        const dmg = Math.round(hero.finalStats.hp * 0.1);
        if (!GameRefs.godMode) StatusEffectService.dealDamage(hero, dmg);
        Logger.event(`Armadilha feriu ${hero.name} em ${dmg}`);
        break;
      }
      case "npc": {
        const heal = Math.round(team.reduce((s, h) => s + h.finalStats.hp, 0) * 0.05);
        for (const h of team) if (h.isAlive) h.currentHP = Math.min(h.finalStats.hp, h.currentHP + heal);
        Logger.event(`NPC viajante curou a equipe em ${heal}`);
        break;
      }
      case "secret": {
        const gem = generateGem(); inventory.addGem(gem); trackRunLoot('gem', gem);
        Logger.event(`Sala secreta: gema ${GemService.gemValue(gem).label}`);
        break;
      }
      case "special": {
        const card = generateCard(); inventory.addCard(card); trackRunLoot('card', card);
        Logger.event(`Evento especial: carta ${CardService.def(card).name}`);
        break;
      }
    }
    const result = abyss.registerKill();
    if (result.advanced) { Logger.event(`Profundidade ${abyss.depth} alcançada!`); EventBus.emit("OnDepthCompleted", { depth: abyss.depth }); }
  }

  function enterRoom() {
    if (window.EXPEDITION_PAUSED) {
      beginEncounter(abyss.bossReady ? [spawnEnemyForDepth(abyss.depth, true)] : spawnCommonEncounter(abyss.depth));
      return;
    }
    if (abyss.bossReady) {
      beginEncounter([spawnEnemyForDepth(abyss.depth, true)]);
    } else {
      const type = rollRoomType();
      if (type === "monster") {
        beginEncounter(spawnCommonEncounter(abyss.depth));
      } else if (type === "elite") {
        const enemy = spawnEnemyForDepth(abyss.depth);
        enemy.stats.hp = Math.round(enemy.stats.hp * 1.6); enemy.currentHP = enemy.stats.hp;
        enemy.stats.atk = Math.round(enemy.stats.atk * 1.4);
        enemy.isElite = true;
        enemy.name = "Elite " + enemy.name;
        beginEncounter([enemy]);
      } else {
        resolveNonCombatRoom(type);
        enterRoom();
        return;
      }
    }
  }

  const respawnEnemy = () => {
    if (team.every(h => !h.isAlive)) return;
    if (encounter.completionProcessed || livingEnemies(encounter).length > 0) return;
    encounter.completionProcessed = true;
    const enemies = encounter.enemies.length ? encounter.enemies : [encounter.current];
    const lead = enemies[0];
    const wasBoss = lead.isBoss;
    const wasElite = !!lead.isElite, wasSemi = !!lead.isSemiBoss;
    const killedName = enemies.length > 1 ? `${enemies.length} inimigos derrotados` : lead.name;
    for (const enemy of enemies) {
      Logger.event(`${enemy.name} derrotado!`);
      EventBus.emit("OnEnemyKilled", { name: enemy.name, depth: abyss.depth, isBoss: !!enemy.isBoss });
    }
    EventBus.emit("OnCombatEnded", { depth: abyss.depth });
    if (wasBoss) EventBus.emit("OnBossDefeated", { name: lead.name, depth: abyss.depth });

    const goldDrop = wasBoss ? 200 : Math.round((8 + Math.floor(abyss.depth * 1.5)) * (wasElite ? 2 : 1));
    CurrencyService.addCurrency(camp, "gold", goldDrop);
    const lootNames = [];
    const crystalDrop = (wasBoss || wasSemi) ? getBossCrystalReward(abyss.depth) : 0;
    if (crystalDrop > 0) {
      CurrencyService.addCurrency(camp, "diamonds", crystalDrop);
      lootNames.push(`💎 +${crystalDrop} cristais`);
      toast(`💎 +${crystalDrop} cristais coletados!`, 'epic');
      Logger.event(`${wasBoss ? 'Boss' : 'Semi-Boss'} derrotado: +${crystalDrop} cristais (${selectedDifficulty || 'normal'})`);
      G.save.save();
    }
    campController.registerKill();
    const xpDrop = wasBoss ? 150 : Math.round((5 + abyss.depth) * (wasElite ? 2 : 1));
    for (const h of team) { if (h.gainExperience(xpDrop)) Logger.event(`${h.name} subiu para o nível ${h.level}!`); }

    if (Math.random() < (wasBoss || wasElite ? 1 : LOOT_CHANCE)) {
      const slot = Math.random() < 0.5 ? "weapon" : "armor";
      const item = generateItem(abyss.depth, slot);
      inventory.addItem(item); trackRunLoot('item', item);
      Logger.event(`Loot: ${item.name} (${item.affixes.length} affixes)`); lootNames.push(item.name);
      EventBus.emit("OnItemDropped", { kind: "equipment", name: item.name });
    }
    if (Math.random() < 0.3) {
      const gem = generateGem();
      inventory.addGem(gem); trackRunLoot('gem', gem);
      Logger.event(`Loot: gema ${GemService.gemValue(gem).label} Lv${gem.level}`); lootNames.push(`Gema ${GemService.gemValue(gem).label} Lv${gem.level}`);
      EventBus.emit("OnItemDropped", { kind: "gem", name: GemService.gemValue(gem).label });
    }
    if (Math.random() < 0.15) {
      const card = generateCard();
      inventory.addCard(card); trackRunLoot('card', card);
      Logger.event(`Loot: carta ${CardService.def(card).name} ${card.stars}★`); lootNames.push(`Carta ${CardService.def(card).name} ${card.stars}★`);
      EventBus.emit("OnItemDropped", { kind: "card", name: CardService.def(card).name });
    }
    if (Math.random() < 0.1) {
      const pet = generatePet();
      inventory.addPet(pet); trackRunLoot('pet', pet);
      Logger.event(`Loot: pet ${PetService.def(pet).name} (${pet.rarityLabel})`); lootNames.push(`Pet ${PetService.def(pet).name}`);
      EventBus.emit("OnItemDropped", { kind: "pet", name: PetService.def(pet).name });
    }

    EventBus.emit("OnVictory", { name: killedName, depth: abyss.depth, isBoss: wasBoss, isElite: wasElite, isSemi: wasSemi, gold: goldDrop, xp: xpDrop, loot: lootNames });
    const result = abyss.registerKill();
    if (result.victory) {
      Logger.event("Boss do Abyss derrotado! Vitória do MVP.");
    } else if (result.advanced) {
      Logger.event(`Profundidade ${abyss.depth} alcançada!`);
      EventBus.emit("OnDepthCompleted", { depth: abyss.depth });
      for (const h of team) {
        if (h.isAlive) h.currentHP = Math.min(h.finalStats.hp, h.currentHP + h.finalStats.hp * 0.2);
      }
    }
    enterRoom();
    GameRefs.intermission = 3;
    if (UI && UI.onEnemySpawn) UI.onEnemySpawn({ victory: true });
  };
  
  const combat = new AutoCombatController(team, encounter, respawnEnemy);
  const enemyAI = new EnemyAIController(team, encounter);
  const bossController = new BossController(team, encounter);
  const skillSystem = new SkillSystem(team, encounter);
  loop.registerSystem(combat);
  loop.registerSystem(enemyAI);
  loop.registerSystem(bossController);
  loop.registerSystem(new StatusEffectController(team, encounter));
  loop.registerSystem(skillSystem);
  const petController = new PetController(team, encounter, petRoster, inventory);
  loop.registerSystem(petController);
  const campController = new CampController(camp);
  loop.registerSystem(campController);

  const result = mode === 'load' ? save.load() : null;
  const offlineSummary = null;
  setEncounter(encounter, abyss.bossReady ? [spawnEnemyForDepth(abyss.depth, true)] : spawnCommonEncounter(abyss.depth));
  
  if (offlineSummary) {
    Logger.event(`Offline (${Math.round(offlineSummary.elapsedSec)}s): ${offlineSummary.kills} kills, ` +
      `+${offlineSummary.goldGained}g, +${offlineSummary.materialsGained} materiais, +${offlineSummary.foodGained} comida, ` +
      `+${offlineSummary.xpGained} XP/herói` +
      (offlineSummary.depthTo > offlineSummary.depthFrom ? `, profundidade ${offlineSummary.depthFrom}→${offlineSummary.depthTo}` : "") +
      (offlineSummary.anyLevelUp ? " (level up!)" : ""));
  }

  return { loop, save, abyss, stageStars, inventory, petRoster, camp, prestige, team, encounter, skillSystem, campController, enterRoom, offlineSummary, result };
}

function init(mode) {
  Logger.el = null;
  if (G && G.loop && G.loop.pause) G.loop.pause();
  GameRefs.combatPaused = false; GameRefs.intermission = 0; GameRefs.runLoot = [];
  if (mode === 'new') { GameRefs.autoBattle = false; GachaService.pityCounters = {}; }
  G = setupGame(mode, UI.slot);
  window.EXPEDITION_PAUSED = true; UI.fresh = true; GameRefs.campHold = true;
  renderAuto(); renderPause();
  
  if (!UI.handlersBound) {
    UI.handlersBound = true;
    EventBus.on('OnHeroLevelUp', p => { toast(`${p.hero.name} → Nível ${p.level}!`, 'epic'); });
    EventBus.on('OnItemDropped', p => toast('Loot: ' + p.name, 'good'));
    EventBus.on('OnVictory', p => showVictory(p));
    EventBus.on('OnBossDefeated', () => { if (UI.screen !== 'abyss') toast('Boss derrotado!', 'epic'); });
    EventBus.on('OnStageCleared', p => {
      if (!G) return;
      const rating = G.stageStars.record(p.depth, G.team);
      const previousStars = rating.previous || 0, newCrystals = Math.max(0, rating.best - previousStars);
      if (newCrystals > 0) { CurrencyService.addCurrency(G.camp, 'diamonds', newCrystals); toast(`💎 +${newCrystals} cristais coletados!`, 'epic'); }
      G.save.save();
      if (UI.stageClear) return;
      window.EXPEDITION_PAUSED = true;
      UI.stageClear = { depth: p.depth, next: p.last ? null : p.depth + 1, stars: rating.best, newStars: Math.max(0, rating.best - previousStars), crystals: newCrystals, newRecord: rating.best > previousStars };
      UI.stageAutoAdvance = !!UI.stageClear.next;
      GameRefs.intermission = Math.max(GameRefs.intermission, 5);
      if (p.last) showDemoEnd(); else showStageClear(UI.stageClear);
    });
    EventBus.on('OnDepthCompleted', p => toast('Profundidade ' + p.depth, 'good'));
  }
  
  buildArena(); buildEnemy(); goto('camp');
  UI.onEnemySpawn = (o) => { buildEnemy(o); };
  G.loop.start();
  
  if (!UI.timersBound) {
    UI.timersBound = true;
    setInterval(() => { if($('hGold')) $('hGold').textContent = '🪙 ' + fmt(G.camp.gold); if($('hDia')) $('hDia').textContent = '💎 ' + fmt(G.camp.currencies.diamonds); if($('hDepth')) $('hDepth').textContent = `Prof. ${G.abyss.depth} · ${G.team[0].level}/${G.team[1].level}/${G.team[2].level}`; if (!window.EXPEDITION_PAUSED && G.team.every(h => !h.isAlive)) handleDefeat(); }, 250);
    setInterval(() => {
      if (UI.screen !== 'abyss') return;
      updateArena();
      const countdown = $('stageNextCountdown');
      if (UI.stageAutoAdvance && countdown) {
        const seconds = Math.max(1, Math.ceil(GameRefs.intermission));
        countdown.textContent = seconds;
        if (GameRefs.intermission <= 0) ACT.stageNext();
      }
    }, 100);
    setInterval(() => { if (Date.now() - UI.touch < 1500) return; if (UI.screen === 'camp') renderCamp(); if (UI.screen === 'heroes') renderHeroes(); if (UI.screen === 'pets') renderPetEvolution(); if (UI.screen === 'weapons') renderWeaponEvolution(); }, 1500);
    const sv = () => { if (!window.__noSave) G.save.save(); };
    setInterval(sv, 10000); document.addEventListener('visibilitychange', () => { if (document.hidden) sv(); }); window.addEventListener('beforeunload', sv);
  }
  if (G.offlineSummary && G.offlineSummary.elapsedSec >= 30) offlineModal(G.offlineSummary);
}

/* =========================================================
   MENUS E CONTROLE DE TELA
   ========================================================= */
let selectedDifficulty = (() => { try { const saved = localStorage.getItem('abyssRealmsDifficulty'); return ['facil','normal','dificil'].includes(saved) ? saved : 'normal'; } catch (_) { return 'normal'; } })();
function showDifficulty() {
  const opts = [ ['facil','Fácil','Combates mais acessíveis'], ['normal','Normal','Experiência padrão'], ['dificil','Difícil','Desafio elevado'] ];
  showOv(`<h2 class="d" style="font-size:20px;margin-bottom:4px">Escolha a dificuldade</h2><div class="dim">Ajuste de dificuldade</div>
    <div style="display:grid;gap:9px;margin-top:16px">${opts.map(([id,label,desc])=>`<button class="btn ${selectedDifficulty===id?'pri':' '}" data-act="difficultyPick" data-difficulty="${id}" style="padding:11px 12px;text-align:left;display:flex;flex-direction:column;gap:3px"><span>${label}</span><small class="dim" style="font-size:10px">${desc}</small></button>`).join('')}</div>
    <div class="ov-actions" style="margin-top:14px"><button class="btn pri" data-act="difficultyContinue" style="padding:12px">Continuar</button><button class="btn sec" data-act="menuBack" style="padding:12px">Voltar</button></div>
    <div class="dim" style="font-size:10px;margin-top:8px">Fácil reduz os atributos dos inimigos para ajudar jogadores iniciantes. Normal e Difícil aguardam balanceamento.</div>`);
  $('ov').classList.add('menu-home');
}
function readSaveInfo(i) {
  try {
    const d = JSON.parse(localStorage.getItem(SAVE_SLOTS[i]) || 'null'); if (!d || !d.systems) return null;
    const a = d.systems.abyssProgress || {}, h = (d.systems.team && d.systems.team.heroes) || [];
    return { depth: a.depth || 1, best: Math.max(a.best || 0, a.depth || 1), levels: h.map(x => x.level).join('/'), ts: d.lastOnlineTimestamp };
  } catch (e) { return null; }
}
const anySave = () => { try { return SAVE_SLOTS.some((_, i) => readSaveInfo(i)); } catch (e) { return false; } };
function showMenu() {
  const any = anySave();
  showOv(`<h2 class="d" style="font-size:22px">Abyss Realms</h2><div class="dim">The Hollow Depths</div>
    <div class="ov-actions" style="margin-top:20px">
      <button class="btn pri" data-act="menuNew" style="padding:13px;font-size:13px">Jogo Novo</button>
      <button class="btn" data-act="menuLoad" style="padding:13px;font-size:13px" ${any ? '' : 'disabled'}>Jogo Salvo</button></div>
    ${any ? '' : '<div class="dim" style="margin-top:10px">Nenhum jogo salvo.</div>'}`);
  $('ov').classList.add('menu-home');
}
function demoScore() { let s = 0; for (let d = 1; d <= ABYSS_CONFIG.maxDepth; d++) s += G.stageStars.get(d); return { stars: s, max: ABYSS_CONFIG.maxDepth * 3 }; }
function showDemoEnd() {
  const sc = demoScore();
  showOv(`<h2 class="d" style="font-size:24px">🏆 Parabéns!</h2><div style="margin:4px 0 0">Você chegou ao fim da demo</div>
    <h2 class="d" style="font-size:26px;margin:14px 0 0">Abyss Realms</h2><div class="dim">The Hollow Depths</div>
    <div class="panel" style="margin:14px 0 4px"><div class="dim">Pontuação conquistada</div><div class="d" style="font-size:28px;color:var(--gold)">⭐ ${sc.stars} / ${sc.max}</div><div class="dim" style="font-size:11px">estrelas das ${ABYSS_CONFIG.maxDepth} fases</div></div>
    <div class="ov-actions" style="margin-top:14px"><button class="btn pri" data-act="demoHome" style="padding:13px;font-size:13px">Voltar à tela inicial</button><button class="btn" data-act="demoContinue" style="padding:13px;font-size:13px">Continuar jogando</button></div>`);
  $('ov').classList.add('menu-home');
}
function slotRow(i, kind) {
  const s = readSaveInfo(i), can = kind === 'new' || !!s;
  const txt = s ? `Prof. ${s.depth} · fronteira ${s.best}/${ABYSS_CONFIG.maxDepth}<br>Heróis Nv ${s.levels}${s.ts ? '<br>Salvo em ' + new Date(s.ts).toLocaleString('pt-BR') : ''}` : 'Vazio';
  const pick = `<button class="btn sm ${kind === 'new' ? '' : 'pri'}" data-act="slotPick" data-k="${kind}" data-i="${i}" ${can ? '' : 'disabled'}>${kind === 'new' ? (s ? 'Sobrescrever' : 'Iniciar') : 'Continuar'}</button>`;
  const del = s ? `<button class="btn sm" data-act="slotDelete" data-i="${i}" style="border-color:var(--red);color:var(--red);white-space:nowrap">Excluir</button>` : '';
  return `<div class="srow${s ? ' fr' : ''}" style="text-align:left"><div class="sn d">${i + 1}</div><div class="si"><b>Slot ${i + 1}</b><br>${txt}</div><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${pick}${del}</div></div>`;
}
function showSlots(kind) {
  showOv(`<h2 class="d" style="font-size:16px">${kind === 'new' ? 'Jogo Novo · escolha o slot' : 'Jogo Salvo'}</h2><div class="slot-grid" style="margin:12px 0">${SAVE_SLOTS.map((_, i) => slotRow(i, kind)).join('')}</div><button class="btn sec" data-act="menuBack" style="width:100%;padding:10px">Voltar</button>`);
}
Object.assign(ACT, {
  demoHome: () => ACT.menuToMenu(),
  demoContinue: () => { if (UI.stageClear) showStageClear(UI.stageClear); else hideOv(); },
  menuNew: () => showDifficulty(),
  difficultyPick: d => { if (['facil','normal','dificil'].includes(d.difficulty)) { selectedDifficulty = d.difficulty; try { localStorage.setItem('abyssRealmsDifficulty', selectedDifficulty); } catch (_) {} showDifficulty(); } },
  difficultyContinue: () => showSlots('new'),
  menuLoad: () => anySave() ? showSlots('load') : showMenu(),
  slotPick: d => { const i = +d.i;
    if (d.k === 'load') return readSaveInfo(i) ? startGame('load', i) : showSlots('load');
    if (!readSaveInfo(i)) return startGame('new', i);
    showOv(`<h2 class="d" style="font-size:16px">Sobrescrever o Slot ${i + 1}?</h2><div class="dim" style="margin:8px 0 16px">O slot já tem um jogo salvo. Iniciar um Jogo Novo vai substituí-lo.</div>
      <div class="ov-actions"><button class="btn pri" data-act="menuNewGo" data-i="${i}">Sobrescrever e iniciar</button><button class="btn sec" data-act="menuNew">Cancelar</button></div>`, true); },
  slotDelete: d => { const i = Number(d.i); if (!Number.isInteger(i) || i < 0 || i >= SAVE_SLOTS.length || !readSaveInfo(i)) return showSlots('load');
    askConfirm(`Excluir permanentemente o jogo salvo do Slot ${i + 1}? Esta ação não pode ser desfeita.`, () => { try { localStorage.removeItem(SAVE_SLOTS[i]); } catch (e) { toast('Não foi possível excluir o jogo salvo'); return showSlots('load'); } toast(`Jogo salvo do Slot ${i + 1} excluído`, 'good'); showSlots('load'); }, 'Excluir jogo'); },
  menuNewGo: d => startGame('new', +d.i),
  menuBack: () => showMenu(),
  menuToMenu: () => { if (G && G.save) G.save.save(); window.EXPEDITION_PAUSED = true; UI.stageAutoAdvance = false; UI.stageClear = null; showMenu(); }
});
function startGame(mode, slot) { UI.slot = slot; hideOv(); init(mode); }

/* =========================================================
   INICIALIZAÇÃO DO JOGO
   ========================================================= */
(function fullscreenController() {
  const button = document.getElementById('fullscreenToggle');
  const root = document.documentElement;
  const stage = document.getElementById('stage') || root;
  if (!button) return;
  const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || root.classList.contains('game-fullscreen'));
  function update(){
    const active = isFullscreen();
    button.textContent = active ? '⤢' : '⛶';
    button.setAttribute('aria-label', active ? 'Sair da tela cheia' : 'Ativar tela cheia');
    button.title = active ? 'Sair da tela cheia' : 'Tela cheia';
    button.setAttribute('aria-pressed', String(active));
  }
  async function enter(){
    const request = stage.requestFullscreen || stage.webkitRequestFullscreen || stage.msRequestFullscreen;
    if (request) {
      try { await request.call(stage); root.classList.remove('game-fullscreen'); update(); return; } catch (e) {}
    }
    root.classList.add('game-fullscreen'); update(); window.dispatchEvent(new Event('resize'));
  }
  async function exit(){
    const exitFn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exitFn && (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement)) {
      try { await exitFn.call(document); } catch(e) {}
    }
    root.classList.remove('game-fullscreen'); update(); window.dispatchEvent(new Event('resize'));
  }
  button.addEventListener('click', function(){ if (isFullscreen()) exit(); else enter(); });
  ['fullscreenchange','webkitfullscreenchange','MSFullscreenChange'].forEach(ev => document.addEventListener(ev, update));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && root.classList.contains('game-fullscreen')) exit(); });
  window.addEventListener('resize', update);
  update();
})();

(function customPhaseBackgrounds() {
  function updatePhaseBG(){
    const depth = Number(window.G && window.G.abyss && window.G.abyss.depth || document.getElementById('phaseNum')?.textContent || 1);
    const arena = document.querySelector('.arena'); if(!arena) return;
    
    const customFase = (window.NOVAS_FASES || []).find(f => f.id === depth);
    
    if (customFase && customFase.fundo) {
      arena.classList.add('phase-bg-10-20');
      const portrait = window.matchMedia('(orientation: portrait)').matches;
      const bgUrl = portrait ? customFase.fundo.portrait : customFase.fundo.landscape;
      arena.style.backgroundImage = `url("${bgUrl}")`;
    } else if (depth >= 10 && depth <= 20) {
      arena.classList.add('phase-bg-10-20');
      const portrait = window.matchMedia('(orientation: portrait)').matches;
      arena.style.backgroundImage = 'url("' + (portrait ? 'assets/phase-10-20-portrait.png' : 'assets/phase-10-20-landscape.png') + '")';
    } else {
      arena.classList.remove('phase-bg-10-20');
      arena.style.removeProperty('background-image'); arena.style.removeProperty('background-size');
      arena.style.removeProperty('background-position'); arena.style.removeProperty('background-repeat');
    }
  }
  window.addEventListener('resize', updatePhaseBG); window.addEventListener('orientationchange', updatePhaseBG);
  setInterval(updatePhaseBG, 500); document.addEventListener('DOMContentLoaded', updatePhaseBG);
})();

try { showMenu(); } catch (e) {
  const ov = document.getElementById("ov"), box = document.getElementById("ovb");
  if (ov && box) {
    ov.classList.add("on","menu-home");
    box.innerHTML = '<h2 class="d">Abyss Realms</h2><div class="dim">The Hollow Depths</div><button class="btn pri" data-act="menuNew">Jogo Novo</button><button class="btn" data-act="menuLoad">Jogo Salvo</button>';
  }
}