# Antigravity 대화 컨텍스트 뷰어 & 토큰 사용량 대시보드 (Antigravity Context & Token Viewer)

<p align="center">
  <img src="https://img.shields.io/badge/Version-2.3.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.x-brightgreen?logo=node.js" alt="Node Version">
  <img src="https://img.shields.io/badge/Dependencies-Zero-success" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform Support">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <a href="README.ja.md">日本語</a> | <b>한국어</b> | <a href="README.es.md">Español</a>
</p>

**Google Antigravity 데스크톱 클라이언트 (2.x)** 를 위해 설계된 순정 스타일의 **「단일 세션 컨텍스트 진행바 + 계정 전체 토큰 사용량 및 7×52 잔디 히트맵 모니터링」** 올인원 시각화 도구입니다. `antigravity-chinese` 와 동일한 **ASAR 영구 인젝션 + CDP 무재부팅 핫 리로드** 구조를 채택하여 **외부 npm 의존성이 전혀 없습니다**. 스크립트 더블 클릭을 통한 간편 설치뿐만 아니라, AI 에이전트(Antigravity / Codex / Claude Code / Cursor)에 한 줄 요청만으로 자동 배포할 수 있습니다.

---

## 🎬 인터페이스 및 동작 미리보기

### 1. 두 모듈 통합 전체 시연 (Combined Full Demo)

<p align="center">
  <a href="assets/demo.mp4">
    <img src="assets/demo.gif" alt="Antigravity 컨텍스트 & 토큰 대시보드 전체 시연" width="760">
  </a>
  <br>
  <sub>🎬 동작 시연: 컨텍스트 뷰어 + 토큰 히트맵 뷰 전환 (<a href="assets/demo.mp4">Full Demo Animation</a>)</sub>
</p>

### 2. 상단 바 듀얼 캡슐: 상태 및 전환 애니메이션

창 우측 상단 바에 테두리 없는 네이티브 캡슐이 상주합니다. 기본 상태에서는 `#1e1e1e` 색상으로 상단 바에 자연스럽게 녹아들며, 마우스 오버 시 `cubic-bezier(0.16, 1, 0.3, 1)` 감쇠 곡선을 통해 부드럽게 `#343434` 로 전환되며 상세 정보가 펼쳐집니다:

| 기능 모듈 | 단독 시연 애니메이션 | 기본 상태 (`#1e1e1e`) | 마우스 오버 상태 (`#343434`) |
| :--- | :---: | :---: | :---: |
| **💬 현재 대화 컨텍스트**<br>*(Session Context)* | <a href="assets/demo-context.mp4"><img src="assets/demo-context.gif" alt="컨텍스트 캡슐 시연" width="320"></a><br><sub><a href="assets/demo-context.mp4">🎬 컨텍스트 단독 시연</a></sub> | <img src="assets/context-badge-default.png" alt="컨텍스트 기본" height="34"><br><sub>진행바 + 사용 퍼센트만 표시</sub> | <img src="assets/context-badge-hover.png" alt="컨텍스트 오버" height="34"><br><sub>예산 상한 및 세션 추정치 확장</sub> |
| **🔥 계정 토큰 기록**<br>*(Account Token Tracker)* | <a href="assets/demo-token.mp4"><img src="assets/demo-token.gif" alt="토큰 캡슐 시연" width="320"></a><br><sub><a href="assets/demo-token.mp4">🎬 토큰 단독 시연</a></sub> | <img src="assets/token-badge-default.png" alt="토큰 기본" height="34"><br><sub>숨쉬는 펄스 점 + 누적 총 사용량</sub> | <img src="assets/token-badge-hover.png" alt="토큰 오버" height="34"><br><sub>당일 실시간 소비량 확장</sub> |

### 3. 듀얼 탭 상세 패널 비교

캡슐을 클릭하면 `#1e1e1e` 다크 패널이 팝업되며, **「💬 현재 대화 컨텍스트」** 와 **「🔥 계정 토큰 활동」** 두 탭을 자유롭게 전환할 수 있습니다:

| 💬 탭 1: 현재 대화 컨텍스트 뷰어 | 🔥 탭 2: 계정 토큰 활동 & 히트맵 |
| :---: | :---: |
| <img src="assets/panel-detail.png" alt="대화 컨텍스트 상세 패널" width="430"> | <img src="assets/panel-activity.png" alt="토큰 활동 패널" width="460"> |
| 최상단 **「⭐ 핵심 사용량 요약」** 카드에서 **현재 사용량 / 예산 상한 / 잔여 공간** 과 상태를 한눈에 확인. 하단에는 모델 실제 반환치, 1M 초과 경고 및 첨부파일 내역 제공. | 상단 4개 카드로 **누적 총량, 오늘, 이번 달, 올해** 집계. 하단에는 **7×52 주 활동 히트맵**을 제공하며 '일별 / 주별 / 누적 추이' 전환 및 날짜별 툴팁 지원. |

---

## 🌐 UI 언어 변경 및 다국어 번역 안내 (UI Localization)

본 플러그인의 기본 UI 텍스트는 **중국어 간체**로 되어 있습니다. 캡슐 텍스트, 상세 패널 및 히트맵을 사용자의 모국어(**한국어 / English / 日本語 / Español** 등)로 표시하고 싶다면:

> [!TIP]
> **별도의 언어 팩 설치나 복잡한 설정 파일 수정이 필요 없습니다!**  
> 저장소를 AI 에이전트(Antigravity / Claude Code / Codex / Cursor)에 전달하여 설치를 요청할 때, 다음과 같이 한마디만 덧붙이세요:  
> **"AGENTS.md를 읽고 플러그인을 설치해 줘. 그리고 UI 텍스트를 [원하는 언어, 예: 한국어 / English]로 번역해서 적용해 줘"**  
> 
> AI가 `meter-renderer.js` 내의 텍스트를 대상 언어로 무손실 번역한 후 자동 패치하여, 재시작 없이 즉시 현지화된 인터페이스로 사용할 수 있습니다.

---

## 🤖 AI 에이전트를 위한 한 줄 설치 안내

AI 에이전트에게: **"`AGENTS.md`를 읽고 이 컨텍스트 뷰어 & 토큰 대시보드를 설치해 줘"** 라고 요청하세요.

에이전트는 저장소 루트에서 다음 명령어를 실행합니다:

```bash
# 1. ASAR 패치 적용 및 실행 중인 Antigravity 창에 무재부팅 핫 리로드
node cli.js install

# 2. 설치 및 작동 상태 확인
node cli.js status
```

---

## 🚀 빠른 시작 (수동 설치)

- **Windows**: [`install.bat`](install.bat) 더블 클릭 실행 (삭제: [`uninstall.bat`](uninstall.bat))
- **macOS / Linux**: `./install.sh` 실행 (삭제: `./uninstall.sh`)
