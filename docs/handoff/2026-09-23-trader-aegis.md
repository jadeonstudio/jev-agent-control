# trader(AEGIS) 인계 메모 — jev 데이터셋 합류 (2026-09-23)

이 문서는 인계용이다. 이 저장소 작업에서 trader 저장소는 수정하지 않았다. 아래 "trader 쪽 변경"은 trader 세션이 판단·구현할 목록이다.

## 현재 상태 (2026-09-23 읽기 전용 확인)

- trader `package.json`: `"jev-agent-control": "file:infrastructure/vendor/jev-agent-control-784e9e594f1b6f95f5eeed95aec1d3b6af41642c.tgz"`.
- AEGIS는 `createDecisionEngine`만 import한다(`aegis/application/composition/research-delta-runtime.ts`, `infrastructure/tools/laya-research-delta-formal.ts`, 타입 선언 `aegis/adapters/research/laya/jev-agent-control.d.ts`).
- AEGIS는 별도 JEV_HOME(`trader/.local-runtime/laya/research-novelty-en-v1/control`)에서 Laya를 연구 보조로 쓴다. 평가는 jev 파이프라인 밖의 자체 스크립트다.
- jev 최신: main `424d5ae` 이후. 패키지 버전 문자열은 여전히 `0.3.0`이다(버전 번호 정책은 미정, UNKNOWN).

## 합류 방법: 직접 소유 runner로 강한 라벨 기록

jev에서 강한 라벨(`objective`/`human`)을 만드는 경로는 세 가지뿐이다: in-process 라이브러리 runner(`store.outcome()`), 사전 등록 `runner verify`, TTY `training correct`. CLI `training outcome` 파이프와 MCP `jev_record`는 항상 약한 `host_review`로 낮춰진다(`SECURITY.md`).

AEGIS의 자체 평가는 AEGIS 프로세스가 직접 측정한 결과이므로 **in-process 라이브러리 runner** 경로가 맞다.

```js
import { createDecisionEngine } from 'jev-agent-control';
import { createTrainingStore } from 'jev-agent-control/training';

const home = '/abs/trader/.local-runtime/laya/research-novelty-en-v1/control'; // AEGIS 전용 JEV_HOME
const engine = createDecisionEngine({ home, env });
const store = createTrainingStore({ home });

// 1) decision: trace가 있어야 데이터셋에 들어간다. capture는 그 JEV_HOME에서 명시적으로 켜져 있어야 한다.
const d = await engine.decide({ purpose, risk: 'routine', state, questions,
  trace: { task_id: <UUID>, snapshot_id: <평가 기준 snapshot의 SHA-256> } });

// 2) AEGIS가 직접 채점한 결과를 같은 decision_id로 기록한다.
store.outcome({
  decision_id: d.id, execution_id: <UUID>, executed: false, final: true, source: 'runner',
  executed_answers: {}, metrics: { latency_ms },
  checks: [{ kind: 'label', passed: true, required: true, scope: 'task', question_id, evidence_ref: 'sha256:<AEGIS 채점 근거 해시>' }],
  labels: [{ question_id, value: <정답 label>, source: 'objective', label_confidence: 1, evidence_ref: 'sha256:<같은 해시>' }],
});
```

- 라벨은 **질문별 독립 assertion**이어야 한다. `kind:'label'` check의 `question_id`·`evidence_ref`가 label과 일치해야 evaluate가 강한 라벨로 인정한다(`src/training/evaluate.mjs`).
- `evidence_ref`는 AEGIS가 보관하는 채점 근거의 SHA-256 참조다. 원문은 jev에 넣지 않는다.
- 이후 흐름은 jev CLI로 같은 JEV_HOME을 지정해 진행한다: `jev-control --home <AEGIS JEV_HOME> training evaluate` → `dataset build`(purpose별 강한 라벨 기본 100 미만이면 거부, `--allow-small`은 manifest에 기록) → `dataset export --format laya` → `training/laya-kit`로 학습 → `laya register/holdout freeze/qualify/compare/promote`.

## JEV_HOME 분리

- AEGIS JEV_HOME과 사용자 호스트용 JEV_HOME(`~/.local/share/jev-agent-control`)은 계속 분리한다. 정책·모드·capture·provider·데이터셋·Laya checkpoint가 JEV_HOME 단위로 독립이다.
- 두 데이터셋을 합치는 기능은 없다. 합류가 필요하면 한쪽 JEV_HOME에서 decision·outcome을 기록하는 쪽으로 통일한다(UNKNOWN: 어느 쪽을 정본으로 둘지 trader 결정 필요).
- Laya checkpoint promote는 JEV_HOME의 `providers.json`만 바꾼다. AEGIS JEV_HOME의 활성 checkpoint는 AEGIS 쪽 명시 명령으로만 바뀐다.

## vendored 버전 갱신 절차 (trader 쪽)

1. jev 저장소에서 원하는 커밋을 고른다(현재 `424d5ae` 이상).
2. `npm pack`으로 tgz를 만들어 `infrastructure/vendor/jev-agent-control-<full-sha>.tgz`로 둔다(파일명에 전체 SHA).
3. `package.json` 의존성 경로를 새 파일명으로 바꾸고 lockfile을 갱신한다. 이전 tgz는 같은 커밋에서 지운다(Dead Artifact 규칙).
4. AEGIS 테스트와 `createDecisionEngine` 사용처를 재검증한다.
5. 새 버전에서 달라진 점: `providers.json` 검증이 `validateProviderConfig`로 공유됐다(형식 불변). engine API 형식은 바뀌지 않았다.

## trader 쪽 변경 목록 (제안, 미구현)

- [ ] vendored tgz를 424d5ae 이상으로 갱신.
- [ ] `jev-agent-control.d.ts`에 `jev-agent-control/training`의 `createTrainingStore`·`outcome` 타입 선언 추가.
- [ ] AEGIS 평가 스크립트에서 decision에 trace를 붙이고, 채점 결과를 위 형식의 runner outcome으로 기록.
- [ ] AEGIS JEV_HOME에서 `training capture on`(owner 승인 필요).
- [ ] 합류 정본 JEV_HOME 결정.

## UNKNOWN

- AEGIS 평가 결과가 jev 질문 형식(choice/noul/score)과 1:1로 대응되는지(질문 설계 확인 필요).
- AEGIS JEV_HOME의 capture 상태와 기존 decision 수.
- 한국어 입력 품질(trader 실측 4–8/12)이 fine-tune 후 개선되는지는 학습·qualify 전까지 알 수 없다.
