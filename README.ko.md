# Antigravity 대화 컨텍스트 뷰어 & 토큰 사용량 대시보드 (Antigravity Context & Token Viewer)

<p align="center">
  <img src="https://img.shields.io/badge/Version-2.7.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.x-brightgreen?logo=node.js" alt="Node Version">
  <img src="https://img.shields.io/badge/Dependencies-Zero-success" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform Support">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/LINUX%20DO-Community-2563EB?logo=linux&logoColor=white" alt="LINUX DO"></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <a href="README.ja.md">日本語</a> | <b>한국어</b> | <a href="README.es.md">Español</a>
</p>

**Google Antigravity 데스크톱 클라이언트 (2.x)** 를 위해 설계된 순정 스타일의 **「단일 세션 컨텍스트 및 생성 모니터링 + 계정 전체 토큰 사용량 및 52주 잔디 히트맵 + 실시간 모델 출력 속도 벤치마크」** 올인원 시각화 도구입니다. `antigravity-chinese` 와 동일한 **ASAR 영구 인젝션 + CDP 무재부팅 핫 리로드** 구조를 채택하여 **외부 npm 의존성이 전혀 없습니다**. 스크립트 더블 클릭을 통한 간편 설치뿐만 아니라, AI 에이전트(Antigravity / Codex / Claude Code / Cursor)에 한 줄 요청만으로 자동 배포할 수 있습니다.

> [!NOTE]
> **다크 모드 및 라이트 모드 적응에 대하여**:  
> 제작자가 게으른 관계로 라이트 모드 캡처 화면과 데모 이미지는 준비되지 않았으나, 라이트 모드 역시 완벽하게 적응되어 정상 지원됩니다 (시스템 및 Antigravity 테마에 맞춰 매끄럽게 자동 전환됩니다).

---

## 🎬 인터페이스 및 동작 시연 영상 (Video & Animation Previews)

v2.7 버전에서는 모든 인터페이스 및 상호작용 레이어를 포함한 4개의 시연 영상을 제공합니다:

### 1. 세션 컨텍스트 모니터링 및 세부 감사
> 시연 영상 파일: `01-세션-컨텍스트-모니터링-및-세부-감사.mp4`

상단 바의 링 캡슐을 클릭하여 「현재 세션 컨텍스트」 패널을 열고, 핵심 사용량 요약, 실시간 생성 속도, 서버 반환값 및 로컬 세션 추정치, 이미지 해상도(예: `561×179 px`)를 포함한 첨부파일 감사 내역을 확인합니다:

<p align="center">
  <a href="assets/demo-01-context-audit.mp4">
    <img src="assets/demo-01-context-audit.gif" alt="세션 컨텍스트 모니터링 및 세부 감사" width="760">
  </a>
  <br>
  <sub>🎬 동작 시연: 세션 컨텍스트 패널, 속도 모니터링 및 세부 매개변수 감사 (<a href="assets/demo-01-context-audit.mp4">고화질 영상: 01-세션-컨텍스트-모니터링-및-세부-감사.mp4</a>)</sub>
</p>

---

### 2. Token 사용 통계 및 52주 히트맵 상호작용
> 시연 영상 파일: `02-Token-사용-통계-및-52주-히트맵-상호작용.mp4`

상단 바의 토큰 누적 캡슐을 클릭하여 「Token 사용량 일람」 패널을 열고 누적/오늘/이번 달/올해 4대 지표 카드와 52주 캘린더 히트맵을 확인합니다. 마우스 호버로 Prompt / Output / Cache 및 미래 날짜 툴팁을 즉시 확인:

<p align="center">
  <a href="assets/demo-02-token-heatmap.mp4">
    <img src="assets/demo-02-token-heatmap.gif" alt="Token 사용 통계 및 52주 히트맵 상호작용" width="760">
  </a>
  <br>
  <sub>🎬 동작 시연: 4대 지표 카드 및 52주 히트맵 호버 상호작용 (<a href="assets/demo-02-token-heatmap.mp4">고화질 영상: 02-Token-사용-통계-및-52주-히트맵-상호작용.mp4</a>)</sub>
</p>

---

### 3. 독립 듀얼 패널 전환 및 화면 맞춤 위치
> 시연 영상 파일: `03-독립-듀얼-패널-전환-및-화면-맞춤-위치.mp4`

우측 보조 사이드바(검토/파일/터미널)가 열린 복잡한 레이아웃에서도 패널이 우측 화면 경계를 감지하여 자동으로 정렬되며 잘림 현상을 방지합니다. 상단 바 캡슐 클릭으로 두 개의 독립 패널을 매끄럽게 교차 전환:

<p align="center">
  <a href="assets/demo-03-panel-switching.mp4">
    <img src="assets/demo-03-panel-switching.gif" alt="독립 듀얼 패널 전환 및 화면 맞춤 위치" width="760">
  </a>
  <br>
  <sub>🎬 동작 시연: 사이드바 잘림 방지 위치 조정 및 독립 듀얼 패널 전환 (<a href="assets/demo-03-panel-switching.mp4">고화질 영상: 03-독립-듀얼-패널-전환-및-화면-맞춤-위치.mp4</a>)</sub>
</p>

---

### 4. 상단 캡슐 다단계 반응형 접기 및 공간 적응
> 시연 영상 파일: `04-상단-캡슐-다단계-반응형-접기-및-공간-적응.mp4`

좌우 사이드바가 모두 열려 중앙 작업 영역 폭이 좁아지면, 상단 바 캡슐군이 4단계 매끄러운 반응형 접기(전체 텍스트 → 숫자만 → 링 아이콘 및 더보기 메뉴)를 실행하여 타이틀바 레이아웃이 깨지지 않도록 보호합니다:

<p align="center">
  <a href="assets/demo-04-responsive-collapse.mp4">
    <img src="assets/demo-04-responsive-collapse.gif" alt="상단 캡슐 다단계 반응형 접기 및 공간 적응" width="760">
  </a>
  <br>
  <sub>🎬 동작 시연: 상단 캡슐 4단계 반응형 접기 및 컴팩트 상태 호출 (<a href="assets/demo-04-responsive-collapse.mp4">고화질 영상: 04-상단-캡슐-다단계-반응형-접기-및-공간-적응.mp4</a>)</sub>
</p>

---

## 📸 스크린샷 및 UI 세부 사항 (Screenshots)

| 01. 대화 컨텍스트 및 생성 속도 메인 화면 | 02. 컨텍스트 전체 확장: 색상 커스텀 및 세부 감사 |
| :---: | :---: |
| <img src="assets/panel-context-main.png" alt="대화 컨텍스트 메인 화면" width="460"> | <img src="assets/panel-context-audit-expanded.png" alt="대화 컨텍스트 전체 확장 패널" width="460"> |
| 상단 **「⭐ 핵심 사용량 요약」** (현재 사용량, 예산 상한, 잔여량) 및 **「⚡ 최신 생성 속도와 소요 시간」** (87.6 tok/s, 10.12s, TTFT 8.72s, 886 tok); 하단에 접이식 서랍 배치. | 서랍 확장: **「🎨 지표 및 배경 색상 커스텀」** (0레벨 다크 배경 및 색상 변경)과 **「📋 기술 매개변수 및 첨부파일 감사」** (서버 실측값, 이미지 해상도 `561×179 px`, 재스캔 버튼). |

| 03. 상단 링 캡슐, 실시간 속도 및 네이티브 툴팁 | 04. Token 사용량 총람 및 5단계 히트맵 개별 커스텀 |
| :---: | :---: |
| <img src="assets/capsule-speed-and-tooltip.png" alt="상단 캡슐 및 툴팁" width="460"> | <img src="assets/panel-token-heatmap-customizer.png" alt="Token 사용량 총람 및 히트맵 커스텀" width="460"> |
| 상단 바 상주 링 진행 캡슐 및 ⚡ 속도 캡슐 (87.6 tok/s); 마우스 호버 시 3계층 네이티브 툴팁으로 사용 퍼센트와 토큰 수치를 명확하게 표시. | **누적 (Total), 오늘 (Today), 이번 달 (Month), 올해 (Year)** 4대 카드; 52주 히트맵 (일별/주별/누적); 하단에 **5종 프리셋**, **5단계 개별 컬러피커**, **선형 보간** 제공. |

---

## ✨ 핵심 기능 요약

1. **상단 바 링 지표 및 고속 모델 성능 모니터링**:
   - 네이티브 다크에 어우러지는 상단 캡슐 및 호버 애니메이션.
   - 단일 세션 사용량을 직관적으로 나타내는 원형 링 (`#badge-context`).
   - TTFT 지연 시간, 스트리밍 속도(tok/s), 총 생성 시간을 기록하는 속도 캡슐 (`#badge-speed`).
   - 좁은 화면에서도 타이틀바를 지켜주는 4단계 반응형 계단식 접기.
2. **독립 듀얼 패널 구조 및 잘림 방지 위치 정렬**:
   - 세션 컨텍스트 패널과 Token 통계 패널을 분리하여 상단 캡슐에서 즉시 전환.
   - 우측 보조 사이드바가 열려도 화면 밖으로 잘리지 않도록 동적 위치 계산.
3. **세션 컨텍스트 및 첨부파일 감사 (Panel A)**:
   - 핵심 사용량 요약 (사용량 / 상한 / 잔여 공간).
   - 생성 속도, 지연 시간(TTFT), 생성 효율 등급 평가.
   - 이미지 해상도(`561×179 px`), Office 문서, PDF, 코드 파일 첨부파일 감사.
   - 대화 세션 전체 재스캔 지원.
4. **계정 Token 누적 및 52주 히트맵 (Panel B)**:
   - 누적, 오늘, 이번 달, 올해 통계 (국제 약어 M / B 단위).
   - GitHub 스타일 52주 히트맵 (일별 / 주별 / 누적 추이).
   - 5종 컬러 프리셋, 범례 직접 클릭을 통한 5단계 개별 조색, 양단 선형 보간기.

---

## 🌐 UI 다국어 번역 안내 (UI Localization)

기본 UI 언어는 **중국어 간체**입니다. 한국어 등 원하는 언어로 변경하려면:

> [!TIP]
> AI 에이전트에게 다음과 같이 요청하세요:  
> **"AGENTS.md를 읽고 플러그인을 설치해 줘. 그리고 meter-renderer.js의 UI 텍스트를 한국어로 번역해 줘"**

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
node --test meter-core.test.js meter-renderer.test.js
```
38개 테스트 모두 통과.

---

## 🤝 커뮤니티

- **[LINUX DO](https://linux.do/)**: LINUX DO 커뮤니티를 지지하고 응원합니다.
