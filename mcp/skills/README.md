# Skills de pey para agentes

Cuatro skills en español, en formato `SKILL.md` (frontmatter `name` y `description` + instrucciones), para entregárselas a un agente de IA que tenga conectado el servidor MCP de pey (`docs/mcp.md`):

| Skill | Cuándo se usa | Herramientas MCP |
| --- | --- | --- |
| [`cobra-al-cliente`](cobra-al-cliente/SKILL.md) | «Cóbrale 150 a Ana» | `crear_cobro` |
| [`revisa-si-pago`](revisa-si-pago/SKILL.md) | «¿Ya pagó?» | `revisar_cobro` |
| [`reconcilia-el-dia`](reconcilia-el-dia/SKILL.md) | «Haz el corte de hoy» | `conciliar_dia` |
| [`da-de-alta-mi-cuenta`](da-de-alta-mi-cuenta/SKILL.md) | «Registra mi CLABE» | `registrar_cuenta`, `consultar_cuenta` |

Son las mismas instrucciones que el servidor publica como **prompts MCP** (`cobra_al_cliente`, `revisa_si_pago`, `reconcilia_el_dia`, `da_de_alta_mi_cuenta`): un cliente MCP las ofrece como comandos; cualquier otro agente puede leer los archivos de esta carpeta directamente (en Cursor o Claude Code, cópialos a `.cursor/skills/` o `.claude/skills/`).
