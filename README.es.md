# Visor de contexto y tokens para Antigravity

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español**

Consulta cuánto contexto usa tu conversación, a qué velocidad responde el modelo y cuántos tokens has usado en la aplicación de escritorio y la CLI desde la barra de Google Antigravity 2.x.

## Funciones

- **Contexto y velocidad**. Consulta el contexto usado, el límite del modelo, el tiempo hasta el primer token (TTFT), la velocidad de salida y el tiempo total. El uso informado por el servidor se muestra por separado de las estimaciones locales.
- **Detalles de la conversación**. Desglosa las solicitudes, respuestas, razonamiento, herramientas y adjuntos. Consulta las estimaciones de adjuntos, su cobertura y las dimensiones de imágenes cuando estén disponibles. El panel distingue desbordamientos de contexto, límites de frecuencia y errores de red.
- **Historial de tokens**. Combina los datos locales legibles de escritorio y CLI, o filtra por origen. Explora vistas diarias, semanales, mensuales, anuales y acumuladas.
- **Estimaciones de API y suscripción**. Estima el coste de entrada, caché y salida con las tarifas compatibles e identifica el uso sin precio. Compara el coste equivalente de API con precios regionales de referencia o con tu pago real, con selección de moneda y conversión a CNY. Las estimaciones sirven para comparar. Consulta al proveedor para conocer los cargos reales.
- **Apariencia**. La barra se adapta al espacio disponible y los paneles se abren por separado. Puedes cambiar de tema y elegir los colores del mapa de calor.
- **CLI y actualizaciones**. Abre la CLI instalada desde la barra usando el espacio de trabajo y el proxy cuando estén disponibles. Busca actualizaciones en el panel. El instalador admite copias de seguridad, comprobaciones de integridad y restauración.

## Idioma de la interfaz

Las cinco versiones del README son traducciones de la documentación. La interfaz se muestra en chino simplificado y no incluye un selector de idioma. Para usar otro idioma, sigue [AGENTS.md](AGENTS.md), traduce los textos de `src/renderer/`, vuelve a compilar e instala el resultado.

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
npm test
```
Las pruebas cubren el contexto, el almacenamiento, el proxy, el estado de la interfaz y la suscripción.

---

## 🤝 Comunidad

- **[LINUX DO](https://linux.do/)**: Apoyamos activamente a la comunidad LINUX DO.

---

## 🙌 Colaboradores

Los 35 colaboradores de la comunidad acreditados en las notas de cada Release de GitHub están reunidos por versión en [CONTRIBUTORS.md](CONTRIBUTORS.md).

<p align="left">
  <a href="https://github.com/elviscjn-cjn" title="elviscjn-cjn · 作者 / author"><img src="https://github.com/elviscjn-cjn.png?size=96" width="48" height="48" alt="@elviscjn-cjn"></a>
  <a href="https://github.com/Tswatery" title="Tswatery · v0.8.8-rc.1"><img src="https://github.com/Tswatery.png?size=96" width="48" height="48" alt="@Tswatery"></a>
  <a href="https://github.com/Kisaragi-Mio-0127" title="Kisaragi-Mio-0127 · v0.8.9"><img src="https://github.com/Kisaragi-Mio-0127.png?size=96" width="48" height="48" alt="@Kisaragi-Mio-0127"></a>
  <a href="https://github.com/feizaodemon" title="feizaodemon · v0.8.9"><img src="https://github.com/feizaodemon.png?size=96" width="48" height="48" alt="@feizaodemon"></a>
  <a href="https://github.com/yuanyang749" title="yuanyang749 · v0.8.9"><img src="https://github.com/yuanyang749.png?size=96" width="48" height="48" alt="@yuanyang749"></a>
  <a href="https://github.com/JYPYYy" title="JYPYYy · v0.8.6"><img src="https://github.com/JYPYYy.png?size=96" width="48" height="48" alt="@JYPYYy"></a>
  <a href="https://github.com/Nymph-Beta" title="Nymph-Beta · v0.8.9"><img src="https://github.com/Nymph-Beta.png?size=96" width="48" height="48" alt="@Nymph-Beta"></a>
  <a href="https://github.com/Fengsuid" title="Fengsuid · v0.9.0"><img src="https://github.com/Fengsuid.png?size=96" width="48" height="48" alt="@Fengsuid"></a>
  <a href="https://github.com/lllhhhh" title="lllhhhh · v0.9.0"><img src="https://github.com/lllhhhh.png?size=96" width="48" height="48" alt="@lllhhhh"></a>
  <a href="https://github.com/Staaaying" title="Staaaying · v0.9.0"><img src="https://github.com/Staaaying.png?size=96" width="48" height="48" alt="@Staaaying"></a>
  <a href="https://github.com/XiangZheng2283" title="XiangZheng2283 · v0.9.0"><img src="https://github.com/XiangZheng2283.png?size=96" width="48" height="48" alt="@XiangZheng2283"></a>
  <a href="https://github.com/x1051445024" title="x1051445024 · v0.8.1"><img src="https://github.com/x1051445024.png?size=96" width="48" height="48" alt="@x1051445024"></a>
  <a href="https://github.com/Hirasawa8" title="Hirasawa8 · v0.9.0"><img src="https://github.com/Hirasawa8.png?size=96" width="48" height="48" alt="@Hirasawa8"></a>
  <a href="https://github.com/shixin08052" title="shixin08052 · v0.9.0"><img src="https://github.com/shixin08052.png?size=96" width="48" height="48" alt="@shixin08052"></a>
  <a href="https://github.com/Xuhang0607" title="Xuhang0607 · v0.9.0"><img src="https://github.com/Xuhang0607.png?size=96" width="48" height="48" alt="@Xuhang0607"></a>
  <a href="https://github.com/Jemiking" title="Jemiking · v0.8.10"><img src="https://github.com/Jemiking.png?size=96" width="48" height="48" alt="@Jemiking"></a>
  <a href="https://github.com/awu5425" title="awu5425 · v0.9.0"><img src="https://github.com/awu5425.png?size=96" width="48" height="48" alt="@awu5425"></a>
  <a href="https://github.com/LC9999216" title="LC9999216 · v0.9.0"><img src="https://github.com/LC9999216.png?size=96" width="48" height="48" alt="@LC9999216"></a>
  <a href="https://github.com/locking-main-163" title="locking-main-163 · v0.8.10"><img src="https://github.com/locking-main-163.png?size=96" width="48" height="48" alt="@locking-main-163"></a>
  <a href="https://github.com/Lopution" title="Lopution · v0.8.8"><img src="https://github.com/Lopution.png?size=96" width="48" height="48" alt="@Lopution"></a>
  <a href="https://github.com/huron09280" title="huron09280 · v0.8.8-rc.1"><img src="https://github.com/huron09280.png?size=96" width="48" height="48" alt="@huron09280"></a>
  <a href="https://github.com/kyrie21z" title="kyrie21z · v0.8.8"><img src="https://github.com/kyrie21z.png?size=96" width="48" height="48" alt="@kyrie21z"></a>
  <a href="https://github.com/startips" title="startips · v0.8.8-rc.1"><img src="https://github.com/startips.png?size=96" width="48" height="48" alt="@startips"></a>
  <a href="https://github.com/nokiy" title="nokiy · v0.8.4"><img src="https://github.com/nokiy.png?size=96" width="48" height="48" alt="@nokiy"></a>
  <a href="https://github.com/Azreal2021" title="Azreal2021 · v0.8.4"><img src="https://github.com/Azreal2021.png?size=96" width="48" height="48" alt="@Azreal2021"></a>
  <a href="https://github.com/MoiraToki" title="MoiraToki · v0.8.4"><img src="https://github.com/MoiraToki.png?size=96" width="48" height="48" alt="@MoiraToki"></a>
  <a href="https://github.com/yinshengphy" title="yinshengphy · v0.8.4"><img src="https://github.com/yinshengphy.png?size=96" width="48" height="48" alt="@yinshengphy"></a>
  <a href="https://github.com/Andrew-liu" title="Andrew-liu · v0.8.4"><img src="https://github.com/Andrew-liu.png?size=96" width="48" height="48" alt="@Andrew-liu"></a>
  <a href="https://github.com/nocoo" title="nocoo · v0.8.4"><img src="https://github.com/nocoo.png?size=96" width="48" height="48" alt="@nocoo"></a>
  <a href="https://github.com/U1tr0n-Lee" title="U1tr0n-Lee · v0.8.4"><img src="https://github.com/U1tr0n-Lee.png?size=96" width="48" height="48" alt="@U1tr0n-Lee"></a>
  <a href="https://github.com/zhao33079-zhao" title="zhao33079-zhao · v0.8.4"><img src="https://github.com/zhao33079-zhao.png?size=96" width="48" height="48" alt="@zhao33079-zhao"></a>
  <a href="https://github.com/git-aa12138" title="git-aa12138 · v0.8.4"><img src="https://github.com/git-aa12138.png?size=96" width="48" height="48" alt="@git-aa12138"></a>
  <a href="https://github.com/anyu0804" title="anyu0804 · v0.8.3"><img src="https://github.com/anyu0804.png?size=96" width="48" height="48" alt="@anyu0804"></a>
  <a href="https://github.com/Jia131313" title="Jia131313 · v0.8.3"><img src="https://github.com/Jia131313.png?size=96" width="48" height="48" alt="@Jia131313"></a>
  <a href="https://github.com/joyshan1986" title="joyshan1986 · v0.8.3"><img src="https://github.com/joyshan1986.png?size=96" width="48" height="48" alt="@joyshan1986"></a>
  <a href="https://github.com/riandycandra" title="riandycandra · v0.8.4"><img src="https://github.com/riandycandra.png?size=96" width="48" height="48" alt="@riandycandra"></a>
</p>
