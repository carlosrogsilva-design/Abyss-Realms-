// ABYSS REALMS — Bloco de dados: Fases 31–40 (Área 2: Reino dos Orcs)
// Somente dados. Stats base = arquétipo equivalente da Área 1; o motor escala por depth.
// Tier de balanceamento: setor 1 (31–35) ×1.00 | setor 2 (36–40) ×1.10 (já aplicado nos valores abaixo).
// TODO: balanceamento pendente (valores provisórios, não finais).

window.NOVOS_INIMIGOS = window.NOVOS_INIMIGOS || [];
window.NOVOS_INIMIGOS.push(
  // Setor 1 — tier ×1.00
  { id: "ORC_MOB_001", nome: "Goblin Saqueador",        minDepth: 31, statsBase: { hp: 60,  atk: 7,  def: 2, atkSpeed: 1.3 }, sprite: "assets/inimigos/orc_mob_001.png" }, // ágil, frágil
  { id: "ORC_MOB_002", nome: "Guerreiro da Horda",      minDepth: 31, statsBase: { hp: 85,  atk: 9,  def: 5, atkSpeed: 1.0 }, sprite: "assets/inimigos/orc_mob_002.png" }, // corpo a corpo, meio termo
  { id: "ORC_MOB_003", nome: "Caçador da Horda",        minDepth: 32, statsBase: { hp: 90,  atk: 10, def: 3, atkSpeed: 0.9 }, sprite: "assets/inimigos/orc_mob_003.png" }, // ranged
  // Setor 2 — tier ×1.10
  { id: "ORC_MOB_004", nome: "Berserker Sangrento",     minDepth: 36, statsBase: { hp: 110, atk: 14, def: 4, atkSpeed: 1.4 }, sprite: "assets/inimigos/orc_mob_004.png" }, // agressivo
  { id: "ORC_MOB_005", nome: "Xamã das Cinzas",         minDepth: 37, statsBase: { hp: 110, atk: 19, def: 6, atkSpeed: 0.9 }, sprite: "assets/inimigos/orc_mob_005.png" }, // mago
  { id: "ORC_MOB_006", nome: "Troll Quebra-ossos",      minDepth: 38, statsBase: { hp: 264, atk: 13, def: 9, atkSpeed: 0.5 }, sprite: "assets/inimigos/orc_mob_006.png" }  // tanque lento
);

window.NOVAS_FASES = window.NOVAS_FASES || [];
window.NOVAS_FASES.push(
  { id: 31, nome: "Portões da Horda",     bioma: "reino_orcs", inimigos: ["ORC_MOB_001", "ORC_MOB_002"],
    fundo: { landscape: "assets/fases/fase-31-landscape.webp", portrait: "assets/fases/fase-31-portrait.webp" } },
  { id: 32, nome: "Acampamento de Saque", bioma: "reino_orcs", inimigos: ["ORC_MOB_001", "ORC_MOB_002", "ORC_MOB_003"],
    fundo: { landscape: "assets/fases/fase-32-landscape.webp", portrait: "assets/fases/fase-32-portrait.webp" } },
  { id: 33, nome: "Trilha dos Estandartes", bioma: "reino_orcs", inimigos: ["ORC_MOB_001", "ORC_MOB_002", "ORC_MOB_003"],
    fundo: { landscape: "assets/fases/fase-33-landscape.webp", portrait: "assets/fases/fase-33-portrait.webp" } },
  { id: 34, nome: "Fogueiras de Guerra",  bioma: "reino_orcs", inimigos: ["ORC_MOB_001", "ORC_MOB_002", "ORC_MOB_003"],
    fundo: { landscape: "assets/fases/fase-34-landscape.webp", portrait: "assets/fases/fase-34-portrait.webp" } },
  { id: 35, nome: "Barricada de Ossos",   bioma: "reino_orcs", inimigos: ["ORC_MOB_001", "ORC_MOB_002", "ORC_MOB_003"], // semi-boss: tratado pelo motor
    fundo: { landscape: "assets/fases/fase-35-landscape.webp", portrait: "assets/fases/fase-35-portrait.webp" } },
  { id: 36, nome: "Corredor de Guerra",   bioma: "reino_orcs", inimigos: ["ORC_MOB_001", "ORC_MOB_002", "ORC_MOB_003", "ORC_MOB_004"],
    fundo: { landscape: "assets/fases/fase-36-landscape.webp", portrait: "assets/fases/fase-36-portrait.webp" } },
  { id: 37, nome: "Trincheira das Cinzas", bioma: "reino_orcs", inimigos: ["ORC_MOB_002", "ORC_MOB_003", "ORC_MOB_004", "ORC_MOB_005"],
    fundo: { landscape: "assets/fases/fase-37-landscape.webp", portrait: "assets/fases/fase-37-portrait.webp" } },
  { id: 38, nome: "Passagem do Troll",    bioma: "reino_orcs", inimigos: ["ORC_MOB_002", "ORC_MOB_003", "ORC_MOB_004", "ORC_MOB_005", "ORC_MOB_006"],
    fundo: { landscape: "assets/fases/fase-38-landscape.webp", portrait: "assets/fases/fase-38-portrait.webp" } },
  { id: 39, nome: "Arena dos Tambores",   bioma: "reino_orcs", inimigos: ["ORC_MOB_001", "ORC_MOB_003", "ORC_MOB_004", "ORC_MOB_005", "ORC_MOB_006"],
    fundo: { landscape: "assets/fases/fase-39-landscape.webp", portrait: "assets/fases/fase-39-portrait.webp" } },
  { id: 40, nome: "Trono de Ghorak",      bioma: "reino_orcs", inimigos: ["ORC_MOB_002", "ORC_MOB_003", "ORC_MOB_004", "ORC_MOB_005", "ORC_MOB_006"],
    boss: { nome: "Ghorak, Campeão da Horda", hpMult: 3.3, atkMult: 3.3, sprite: "assets/bosses/ORC_BOSS_001.png" }, // ×3 do padrão + 10% (provisório)
    fundo: { landscape: "assets/fases/fase-40-landscape.webp", portrait: "assets/fases/fase-40-portrait.webp" } }
);
// ABYSS REALMS — Bloco de dados: Fases 41–50 (Área 2: Reino dos Orcs, setores 3 e 4)
// Colar ao FINAL do dados-fases.js (usa push; não sobrescreve o bloco 31–40).
// Stats = arquétipo da Área 1 × tier: setor 3 (41–45) ×1.20 | setor 4 (46–50) ×1.30 (já aplicado).
// TODO: balanceamento pendente (valores provisórios, não finais).

window.NOVOS_INIMIGOS = window.NOVOS_INIMIGOS || [];
window.NOVOS_INIMIGOS.push(
  { id: "ORC_MOB_007", nome: "Guardião do Escudo Negro", minDepth: 41, statsBase: { hp: 180, atk: 11, def: 12, atkSpeed: 0.5 }, sprite: "assets/inimigos/orc_mob_007.png" }, // defensivo (≈ Hollow Warden)
  { id: "ORC_MOB_008", nome: "Javali de Guerra",         minDepth: 43, statsBase: { hp: 144, atk: 16, def: 6,  atkSpeed: 1.2 }, sprite: "assets/inimigos/orc_mob_008.png" }, // investida (≈ Brute veloz)
  { id: "ORC_MOB_009", nome: "Carrasco da Fortaleza",    minDepth: 46, statsBase: { hp: 364, atk: 23, def: 16, atkSpeed: 0.5 }, sprite: "assets/inimigos/orc_mob_009.png" }  // elite pesada (≈ Sentinel/Colossus)
);

window.NOVAS_FASES = window.NOVAS_FASES || [];
window.NOVAS_FASES.push(
  { id: 41, nome: "Portão do Pátio",       bioma: "reino_orcs", inimigos: ["ORC_MOB_002", "ORC_MOB_003", "ORC_MOB_004", "ORC_MOB_007"],
    fundo: { landscape: "assets/fases/fase-41-landscape.webp", portrait: "assets/fases/fase-41-portrait.webp" } },
  { id: 42, nome: "Muralha de Escudos",    bioma: "reino_orcs", inimigos: ["ORC_MOB_001", "ORC_MOB_002", "ORC_MOB_003", "ORC_MOB_005", "ORC_MOB_007"],
    fundo: { landscape: "assets/fases/fase-42-landscape.webp", portrait: "assets/fases/fase-42-portrait.webp" } },
  { id: 43, nome: "Chiqueiro de Guerra",   bioma: "reino_orcs", inimigos: ["ORC_MOB_002", "ORC_MOB_004", "ORC_MOB_006", "ORC_MOB_007", "ORC_MOB_008"],
    fundo: { landscape: "assets/fases/fase-43-landscape.webp", portrait: "assets/fases/fase-43-portrait.webp" } },
  { id: 44, nome: "Praça das Lanças",      bioma: "reino_orcs", inimigos: ["ORC_MOB_003", "ORC_MOB_004", "ORC_MOB_005", "ORC_MOB_007", "ORC_MOB_008"],
    fundo: { landscape: "assets/fases/fase-44-landscape.webp", portrait: "assets/fases/fase-44-portrait.webp" } },
  { id: 45, nome: "Cidadela de Ferro",     bioma: "reino_orcs", inimigos: ["ORC_MOB_002", "ORC_MOB_003", "ORC_MOB_006", "ORC_MOB_007", "ORC_MOB_008"], // semi-boss: tratado pelo motor
    fundo: { landscape: "assets/fases/fase-45-landscape.webp", portrait: "assets/fases/fase-45-portrait.webp" } },
  { id: 46, nome: "Ponte Quebrada",        bioma: "reino_orcs", inimigos: ["ORC_MOB_004", "ORC_MOB_005", "ORC_MOB_006", "ORC_MOB_008", "ORC_MOB_009"],
    fundo: { landscape: "assets/fases/fase-46-landscape.webp", portrait: "assets/fases/fase-46-portrait.webp" } },
  { id: 47, nome: "Vão das Correntes",     bioma: "reino_orcs", inimigos: ["ORC_MOB_002", "ORC_MOB_003", "ORC_MOB_007", "ORC_MOB_008", "ORC_MOB_009"],
    fundo: { landscape: "assets/fases/fase-47-landscape.webp", portrait: "assets/fases/fase-47-portrait.webp" } },
  { id: 48, nome: "Ruínas do Cais",        bioma: "reino_orcs", inimigos: ["ORC_MOB_003", "ORC_MOB_004", "ORC_MOB_005", "ORC_MOB_008", "ORC_MOB_009"],
    fundo: { landscape: "assets/fases/fase-48-landscape.webp", portrait: "assets/fases/fase-48-portrait.webp" } },
  { id: 49, nome: "Arco Rachado",          bioma: "reino_orcs", inimigos: ["ORC_MOB_002", "ORC_MOB_005", "ORC_MOB_006", "ORC_MOB_007", "ORC_MOB_009"],
    fundo: { landscape: "assets/fases/fase-49-landscape.webp", portrait: "assets/fases/fase-49-portrait.webp" } },
  { id: 50, nome: "Forja de Dravok",       bioma: "reino_orcs", inimigos: ["ORC_MOB_004", "ORC_MOB_006", "ORC_MOB_007", "ORC_MOB_008", "ORC_MOB_009"],
    boss: { nome: "Dravok, Senhor da Guerra", hpMult: 3.6, atkMult: 3.6, sprite: "assets/bosses/ORC_BOSS_002.png" }, // Ghorak 3.3 +10% (provisório)
    fundo: { landscape: "assets/fases/fase-50-landscape.webp", portrait: "assets/fases/fase-50-portrait.webp" } }
);
