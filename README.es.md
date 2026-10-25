# Visor de Contexto y Panel de Tokens para Antigravity (Antigravity Context & Token Viewer)

<p align="center">
  <img src="https://img.shields.io/badge/Version-2.3.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.x-brightgreen?logo=node.js" alt="Node Version">
  <img src="https://img.shields.io/badge/Dependencies-Zero-success" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform Support">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <b>Español</b>
</p>

Una suite de visualización con acabado nativo para **Google Antigravity Desktop (2.x)** que combina una **barra de progreso de contexto en tiempo real para la sesión** con un **panel de actividad y mapa de calor 7×52 de Tokens de toda la cuenta**. Basado en una arquitectura de **parche persistente ASAR + recarga en caliente vía CDP sin reiniciar**, **sin dependencias externas de npm**. Soporta instalación manual en un clic y despliegue automático mediante agentes de IA (Antigravity / Codex / Claude Code / Cursor).

---

## 🎬 Demostración e Interfaz (Preview)

### 1. Demostración Completa Combinada (Combined Full Demo)

<p align="center">
  <a href="assets/demo.mp4">
    <img src="assets/demo.gif" alt="Demostración completa de contexto y tokens" width="760">
  </a>
  <br>
  <sub>🎬 Animación de demostración: Visor de contexto + cambio de vistas del mapa de calor de tokens (<a href="assets/demo.mp4">Full Demo Animation</a>)</sub>
</p>

### 2. Doble Cápsula en la Barra Superior: Estados y Animaciones

Dos cápsulas sin borde permanecen en la barra superior derecha. En reposo se integran de manera invisible con `#1e1e1e`; al pasar el cursor, hacen una transición suave hacia `#343434` mediante una curva `cubic-bezier(0.16, 1, 0.3, 1)` para mostrar información detallada:

| Módulo | Animación Individual | Estado Normal (`#1e1e1e`) | Al Pasar el Cursor (`#343434`) |
| :--- | :---: | :---: | :---: |
| **💬 Contexto de la Sesión**<br>*(Session Context)* | <a href="assets/demo-context.mp4"><img src="assets/demo-context.gif" alt="Demostración de contexto" width="320"></a><br><sub><a href="assets/demo-context.mp4">🎬 Demo Contexto</a></sub> | <img src="assets/context-badge-default.png" alt="Contexto normal" height="34"><br><sub>Barra de progreso + % de uso</sub> | <img src="assets/context-badge-hover.png" alt="Contexto hover" height="34"><br><sub>Expande límite y estimación total</sub> |
| **🔥 Registro de Tokens**<br>*(Account Token Tracker)* | <a href="assets/demo-token.mp4"><img src="assets/demo-token.gif" alt="Demostración de tokens" width="320"></a><br><sub><a href="assets/demo-token.mp4">🎬 Demo Tokens</a></sub> | <img src="assets/token-badge-default.png" alt="Tokens normal" height="34"><br><sub>Punto pulsante + total acumulado</sub> | <img src="assets/token-badge-hover.png" alt="Tokens hover" height="34"><br><sub>Expande el consumo de hoy</sub> |

### 3. Paneles de Detalle con Doble Pestaña

Al hacer clic en cualquier cápsula se despliega un panel oscuro `#1e1e1e` con cambio instantáneo entre **💬 Contexto de la Sesión** y **🔥 Actividad de Tokens**:

| 💬 Pestaña 1: Visor de Contexto de la Sesión | 🔥 Pestaña 2: Actividad de Tokens y Mapa de Calor |
| :---: | :---: |
| <img src="assets/panel-detail.png" alt="Panel de contexto de la sesión" width="430"> | <img src="assets/panel-activity.png" alt="Panel de actividad de tokens" width="460"> |
| Tarjeta superior **"⭐ Resumen Rápido"** con **Usado / Límite / Disponible** y estado de salud. Valores exactos del modelo, alerta ante límite de 1M y desglose de archivos adjuntos. | Cuatro tarjetas métricas: **Gran Total, Hoy, Mes Actual, Año Actual**. Mapa de calor **7×52 semanas** con vistas **Diaria / Semanal / Acumulada** y tooltips con desglose diario. |

---

## 🌐 Localización e Idiomas de la Interfaz (UI Localization)

El idioma predeterminado de la interfaz es **Chino Simplificado**. Si prefieres que el texto de las cápsulas, paneles y descripciones se muestre en tu idioma nativo (**Español, English, 日本語, 한국어**, etc.):

> [!TIP]
> **¡No necesitas instalar paquetes de idiomas adicionales ni modificar archivos de configuración!**  
> Cuando le pidas a tu Agente de IA (Antigravity / Claude Code / Codex / Cursor) que instale este repositorio, simplemente indícale:  
> **"Lee AGENTS.md, instala este plugin y traduce los textos de la interfaz al [tu idioma, p. ej., Español / English]"**  
> 
> La IA traducirá automáticamente las cadenas de texto en `meter-renderer.js` e inyectará los cambios en caliente sin reiniciar la aplicación.

---

## 🤖 Instalación para Agentes de IA

Pídele a tu asistente de IA: **"Lee `AGENTS.md` e instala este visor de contexto y tokens"**.

El agente ejecutará:

```bash
# 1. Parche ASAR en caliente sin reiniciar
node cli.js install

# 2. Verificar estado
node cli.js status
```

---

## 🚀 Inicio Rápido para Usuarios

- **Windows**: Doble clic en [`install.bat`](install.bat) (Desinstalar: [`uninstall.bat`](uninstall.bat))
- **macOS / Linux**: Ejecutar `./install.sh` (Desinstalar: `./uninstall.sh`)
