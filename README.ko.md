# Antigravity 컨텍스트 및 토큰 뷰어

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md)

Google Antigravity 2.x 도구 모음에서 대화의 컨텍스트 사용량, 모델 응답 속도, 데스크톱과 CLI의 토큰 사용량을 확인할 수 있습니다.

## 기능

- **컨텍스트와 속도**. 컨텍스트 사용량, 모델 한도, 첫 토큰까지 걸린 시간(TTFT), 출력 속도와 전체 생성 시간을 표시합니다. 서버 사용량과 로컬 추정치를 구분합니다.
- **대화 상세**. 프롬프트, 응답, 사고, 도구 호출 및 첨부 파일을 확인합니다. 첨부 파일 추정치와 읽기 범위, 확인 가능한 이미지 크기를 표시합니다. 컨텍스트 초과, 호출 제한, 네트워크 오류 등을 구분합니다.
- **토큰 기록**. 읽을 수 있는 데스크톱과 CLI의 로컬 사용량을 합산하고 출처별로 필터링합니다. 일간, 주간, 월간, 연간 및 누적 보기를 제공합니다.
- **API 비용 추정과 구독**. 지원되는 요금으로 입력, 캐시, 출력 비용을 추정하고 산정할 수 없는 사용량을 표시합니다. 지역별 기준가나 실제 결제액을 API 환산액과 비교할 수 있으며 통화 선택과 위안화 환산을 지원합니다. 추정치는 비교용이며 실제 청구 금액은 서비스 제공업체에서 확인하세요.
- **외관**. 도구 모음은 공간에 맞춰 줄어들며 두 패널을 따로 열 수 있습니다. 밝은 테마와 어두운 테마, 히트맵 프리셋과 단계별 색상을 지원합니다.
- **CLI 및 업데이트**. 도구 모음에서 설치된 CLI를 실행하고 가능한 경우 현재 작업 공간과 프록시를 사용합니다. 패널에서 업데이트를 확인할 수 있습니다. 설치 프로그램은 백업, 무결성 검사 및 복원을 지원합니다.

## 인터페이스 언어

다섯 언어는 README 번역입니다. 인터페이스 기본 언어는 중국어 간체이며 앱 내 언어 선택 메뉴는 없습니다. 다른 언어가 필요하면 [AGENTS.md](AGENTS.md)에 따라 `src/renderer/`의 UI 문구를 번역한 뒤 다시 빌드하고 설치하세요.

---

## 🤖 AI 에이전트 설치 명령어

```bash
node cli.js install
node cli.js status
```

---

## 🚀 빠른 시작

- **Windows**: [`install.bat`](install.bat) / [`uninstall.bat`](uninstall.bat)
- **macOS / Linux**: `./install.sh` / `./uninstall.sh`
- **CLI**: `node cli.js check` / `install` / `status` / `restore`

---

## 🧪 테스트 실행

```bash
npm test
```
컨텍스트 집계, 저장소, 프록시 설정, UI 상태와 구독 설정을 테스트합니다.

---

## 🤝 커뮤니티

- **[LINUX DO](https://linux.do/)**: LINUX DO 커뮤니티를 지지하고 응원합니다.

---

## 🙌 기여자

GitHub Release 노트에 크레디트된 35명의 커뮤니티 기여자입니다. 버전별 목록은 [CONTRIBUTORS.md](CONTRIBUTORS.md)에서 확인할 수 있습니다.

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
