# Visor de Contexto y Panel de Tokens para Antigravity (Antigravity Context & Token Viewer)

<p align="center">
  <img src="https://img.shields.io/badge/Version-2.7.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.x-brightgreen?logo=node.js" alt="Node Version">
  <img src="https://img.shields.io/badge/Dependencies-Zero-success" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform Support">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/LINUX%20DO-Community-2563EB?logo=linux&logoColor=white" alt="LINUX DO"></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <b>Español</b>
</p>

Una suite de visualización con acabado nativo para **Google Antigravity Desktop (2.x)** que combina el **monitoreo de contexto de sesión y generación**, un **panel de actividad y mapa de calor de 52 semanas de Tokens**, y **métricas de velocidad de salida y latencia en tiempo real**. Basado en una arquitectura de **parche persistente ASAR + recarga en caliente vía CDP sin reiniciar**, **sin dependencias externas de npm**. Soporta instalación manual en un clic y despliegue automático mediante agentes de IA (Antigravity / Codex / Claude Code / Cursor).

> [!NOTE]
> **Sobre la adaptación a los modos Claro y Oscuro**:  
> Como el autor es un vago, no hay capturas de pantalla ni imágenes de demostración para el modo claro, pero el modo claro está igualmente adaptado y funciona al 100% (adaptándose fluidamente tanto en la barra superior como en los paneles al tema claro u oscuro).

---

## 🎬 Videos y Animaciones de Demostración (Video & Animation Previews)

Esta versión v2.7 incluye 4 demostraciones en video que cubren todos los niveles de interacción:

### 1. Monitoreo de Contexto de Sesión y Auditoría de Parámetros y Adjuntos
> Archivo de video: `01-monitoreo-contexto-sesion-y-auditoria.mp4`

Haz clic en la cápsula circular de la barra superior para desplegar el panel de Contexto de la Sesión. Revisa el resumen rápido de uso, velocidad de generación, parámetros técnicos, calibración con el servidor y desglose de archivos adjuntos con resolución en píxeles (ej. `561×179 px`):

<p align="center">
  <a href="assets/demo-01-context-audit.mp4">
    <img src="assets/demo-01-context-audit.gif" alt="Monitoreo de Contexto de Sesión y Auditoría de Parámetros y Adjuntos" width="760">
  </a>
  <br>
  <sub>🎬 Demostración: Panel de contexto, velocidad y auditoría detallada (<a href="assets/demo-01-context-audit.mp4">Video HD: 01-monitoreo-contexto-sesion-y-auditoria.mp4</a>)</sub>
</p>

---

### 2. Estadísticas de Uso de Tokens e Interacción con el Mapa de Calor de 52 Semanas
> Archivo de video: `02-estadisticas-uso-token-e-interaccion-mapa-calor.mp4`

Haz clic en la cápsula de tokens acumulados para abrir el panel de Tokens, con tarjetas de métricas en 4 dimensiones (Total, Hoy, Mes, Año), mapa de calor de 52 semanas y tooltips instantáneos al pasar el cursor sobre las celdas con desglose de Prompt/Output/Cache o fechas futuras:

<p align="center">
  <a href="assets/demo-02-token-heatmap.mp4">
    <img src="assets/demo-02-token-heatmap.gif" alt="Estadísticas de Uso de Tokens e Interacción con el Mapa de Calor" width="760">
  </a>
  <br>
  <sub>🎬 Demostración: Tarjetas de métricas y mapa de calor con tooltips interactivos (<a href="assets/demo-02-token-heatmap.mp4">Video HD: 02-estadisticas-uso-token-e-interaccion-mapa-calor.mp4</a>)</sub>
</p>

---

### 3. Cambio Suave entre Paneles Dobles y Posicionamiento Adaptativo
> Archivo de video: `03-cambio-suave-panel-dual-y-posicionamiento-adaptativo.mp4`

Cuando se abre la barra lateral auxiliar derecha (Revisión / Archivos / Terminal), el panel detecta los límites dinámicamente y se acopla para evitar recortes. Al hacer clic entre las cápsulas superiores se cambia suavemente entre ambos paneles independientes:

<p align="center">
  <a href="assets/demo-03-panel-switching.mp4">
    <img src="assets/demo-03-panel-switching.gif" alt="Cambio Suave entre Paneles Dobles y Posicionamiento Adaptativo" width="760">
  </a>
  <br>
  <sub>🎬 Demostración: Acoplamiento sin recortes y alternancia fluida entre paneles (<a href="assets/demo-03-panel-switching.mp4">Video HD: 03-cambio-suave-panel-dual-y-posicionamiento-adaptativo.mp4</a>)</sub>
</p>

---

### 4. Colapso Responsivo Progresivo de Cápsulas y Adaptabilidad Espacial
> Archivo de video: `04-colapso-responsivo-progresivo-capsulas.mp4`

Cuando se abren ambas barras laterales (navegación y herramientas), el grupo de cápsulas ejecuta un colapso responsivo escalonado en 4 niveles (de texto completo a números y luego anillo compacto con menú), manteniendo intacto el diseño de la barra de título:

<p align="center">
  <a href="assets/demo-04-responsive-collapse.mp4">
    <img src="assets/demo-04-responsive-collapse.gif" alt="Colapso Responsivo Progresivo de Cápsulas" width="760">
  </a>
  <br>
  <sub>🎬 Demostración: Colapso escalonado en 4 fases e invocación compacta (<a href="assets/demo-04-responsive-collapse.mp4">Video HD: 04-colapso-responsivo-progresivo-capsulas.mp4</a>)</sub>
</p>

---

## 📸 Capturas de Pantalla y Detalles de Interfaz (Screenshots)

| 01. Vista Principal de Contexto y Velocidad | 02. Contexto Desplegado: Colores y Auditoría |
| :---: | :---: |
| <img src="assets/panel-context-main.png" alt="Vista principal de contexto" width="460"> | <img src="assets/panel-context-audit-expanded.png" alt="Panel de contexto desplegado" width="460"> |
| Tarjeta superior **"⭐ Resumen Rápido"** (Usado, Límite, Disponible) y **"⚡ Velocidad y Latencia"** (87.6 tok/s, 10.12s, 8.72s TTFT, 886 tok producidos); cajones plegables inferiores. | Despliegue de **"🎨 Personalización de Colores"** (fondo de nivel 0 y métricas) y **"📋 Parámetros y Auditoría de Adjuntos"** (respuesta del servidor, resolución de imagen `561×179 px`, reescaneo). |

| 03. Cápsula de Anillo, Velocidad y Tooltip Nativo | 04. Resumen de Tokens y Personalizador de Mapa de Calor |
| :---: | :---: |
| <img src="assets/capsule-speed-and-tooltip.png" alt="Cápsula superior y tooltip" width="460"> | <img src="assets/panel-token-heatmap-customizer.png" alt="Resumen de tokens y personalizador" width="460"> |
| Cápsula de progreso circular y cápsula ⚡ de velocidad (87.6 tok/s); tooltip nativo de 3 capas al pasar el cursor mostrando porcentajes y conteo exacto de tokens. | Cuatro tarjetas: **Total, Hoy, Mes, Año**; mapa de calor de 52 semanas (Diario / Semanal / Acumulado); **5 temas predefinidos**, selector independiente celda por celda e interpolación lineal. |

---

## ✨ Características Principales

1. **Indicador de Anillo Superior y Monitor de Rendimiento**:
   - Integración nativa en modo oscuro con curvas de transición elásticas.
   - Anillo de progreso (`#badge-context`) con 3 niveles de alerta y tooltip nativo.
   - Cápsula de velocidad (`#badge-speed`) con TTFT, velocidad en flujo continuo (tok/s) y duración total.
   - Colapso progresivo en 4 fases ante anchos reducidos.
2. **Arquitectura de Doble Panel Desacoplado y Anti-Recortes**:
   - Paneles independientes para Contexto de Sesión y Actividad de Tokens.
   - Alternancia directa haciendo clic en las cápsulas superiores.
   - Ajuste dinámico de posición que evita que el panel quede oculto tras la barra lateral derecha.
3. **Monitoreo de Contexto y Auditoría de Adjuntos (Panel A)**:
   - Resumen clave de consumo (Usado / Presupuesto / Restante).
   - Evaluación de eficiencia de generación (Rápida / Fluida / Buena / Lenta).
   - Auditoría detallada de archivos adjuntos (Office, PDF, código y dimensiones de imagen en píxeles).
   - Reescaneo completo de la conversación y adjuntos en un clic.
4. **Registro Global de Tokens y Mapa de Calor de 52 Semanas (Panel B)**:
   - Cuatro tarjetas de métricas con abreviaturas internacionales (M / B).
   - Mapa de calor de 52 semanas con vistas Diaria, Semanal y Acumulada.
   - Sistema de color aditivo: 5 ajustes preestablecidos, selección de color celda por celda e interpolación lineal.
5. **Inmunidad de Localización y Montaje en Caliente con CDP**:
   - Conserva al 100% cualquier parche de traducción previo.
   - Recarga en vivo inmediata mediante CDP sin forzar el cierre del proceso `Antigravity.exe`.

---

## 🌐 Localización e Idiomas de la Interfaz (UI Localization)

El idioma predeterminado es **Chino Simplificado**. Para traducirlo a Español o a cualquier otro idioma:

> [!TIP]
> Solo pídele a tu Agente de IA:  
> **"Lee AGENTS.md, instala este plugin y traduce los textos de la interfaz en meter-renderer.js a Español"**.

---

## 🤖 Instrucciones para Agentes de IA

```bash
node cli.js install
node cli.js status
```

---

## 🚀 Inicio Rápido

- **Windows**: [`install.bat`](install.bat) / [`uninstall.bat`](uninstall.bat)
- **macOS / Linux**: `./install.sh` / `./uninstall.sh`
- **CLI**: `node cli.js check` / `install` / `status` / `restore`

---

## 🧪 Pruebas Automatizadas

```bash
node --test meter-core.test.js meter-renderer.test.js
```
38 pruebas ejecutadas y superadas con éxito.

---

## 🤝 Comunidad

- **[LINUX DO](https://linux.do/)**: Apoyamos activamente a la comunidad LINUX DO.
