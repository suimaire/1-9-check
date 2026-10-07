import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../app/context.tsx';
import { DEMO_CLOCKS } from '../lib/backend/demoData.ts';
import type { DemoFailure } from '../lib/backend/demo.ts';
import { errorMessage } from '../lib/messages.ts';
import { cachedBlob, createTrackedUrl, revokeUrl } from '../lib/objectUrls.ts';
import { STATE_LABEL, STATE_SHORT, type SubmitState } from '../lib/status.ts';
import { REVIEW_LABEL, type ReviewStatus, type SubmissionImage } from '../lib/types.ts';

export function StateChip({ state, short }: { state: SubmitState; short?: boolean }) {
  return <span className={`chip st-${state}`}>{short ? STATE_SHORT[state] : STATE_LABEL[state]}</span>;
}

export function ReviewChip({ status }: { status: ReviewStatus }) {
  return <span className={`chip rv-${status}`}>{REVIEW_LABEL[status]}</span>;
}

export function Spinner({ label = '불러오는 중' }: { label?: string }) {
  return (
    <div className="center" role="status" aria-live="polite">
      <div className="row"><div className="spinner" /><span className="muted small">{label}</span></div>
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="banner error row between" role="alert">
      <span>{errorMessage(error)}</span>
      {onRetry && <button className="btn sm" onClick={onRetry}>다시 시도</button>}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>{title}</h2>
          <button className="btn ghost icon-btn" onClick={onClose} aria-label="닫기">닫기</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * 인증된 다운로드로 비공개 이미지를 표시. 화면에서 사라지면 object URL을 해제한다.
 * lazy: 화면(가로 스크롤 영역 포함)에 들어올 때만 내려받고, 불러오는 동안은 빈 칸만 보인다(썸네일용).
 */
export function AuthImage({ path, alt, zoomable, lazy }: { path: string; alt: string; zoomable?: boolean; lazy?: boolean }) {
  const { backend } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [zoomed, setZoomed] = useState(false);
  const [visible, setVisible] = useState(!lazy);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visible || !box.current) return;
    if (typeof IntersectionObserver === 'undefined') return setVisible(true);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    }, { rootMargin: '200px' });
    io.observe(box.current);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!backend || !visible) return;
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    setError(null);
    cachedBlob(path, (p) => backend.fetchImage(p)).then(
      (blob) => {
        if (!alive) return;
        made = createTrackedUrl(blob);
        setUrl(made);
      },
      (err) => alive && setError(err),
    );
    return () => {
      alive = false;
      revokeUrl(made);
    };
  }, [backend, path, visible]);

  if (lazy && (!visible || !url)) {
    return <div ref={box} className="img-placeholder">{error ? '불러오기 실패' : ''}</div>;
  }
  if (error) return <ErrorBanner error={error} />;
  if (!url) return <Spinner label="이미지 불러오는 중" />;
  return (
    <img
      src={url}
      alt={alt}
      className={zoomed ? 'zoomed' : undefined}
      onClick={zoomable ? () => setZoomed((z) => !z) : undefined}
    />
  );
}

/** 한 제출의 사진 세트(1~3장): 선택한 사진을 크게, 여러 장이면 이전/다음과 작은 썸네일. */
export function Gallery({ images, alt, initial = 0 }: { images: SubmissionImage[]; alt: string; initial?: number }) {
  const n = images.length;
  const [index, setIndex] = useState(Math.max(0, Math.min(initial, n - 1)));
  const i = Math.min(index, n - 1);
  const img = images[i];
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="img-box"><AuthImage key={img.path} path={img.path} alt={`${alt} 사진 ${i + 1}`} zoomable /></div>
      {n > 1 && (
        <>
          <div className="row between">
            <button className="btn sm" disabled={i === 0} onClick={() => setIndex(i - 1)} aria-label="이전 사진">◀ 이전</button>
            <span className="small strong">사진 {i + 1} / {n}</span>
            <button className="btn sm" disabled={i === n - 1} onClick={() => setIndex(i + 1)} aria-label="다음 사진">다음 ▶</button>
          </div>
          <div className="thumbs" role="group" aria-label="사진 선택">
            {images.map((im, k) => (
              <button key={im.path} type="button" className="thumb" aria-pressed={k === i} aria-label={`사진 ${k + 1}`} onClick={() => setIndex(k)}>
                <AuthImage path={im.path} alt="" lazy />
                <span className="thumb-no">{k + 1}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function TopBar({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="brand">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <div className="spacer" />
      {right}
    </header>
  );
}

export function DemoBar() {
  const { demo, leaveDemo } = useApp();
  const [, force] = useState(0);
  useEffect(() => demo?.subscribe(() => force((x) => x + 1)), [demo]);
  if (!demo) return null;
  return (
    <div className="banner demo row" role="note">
      <strong>데모 모드</strong>
      <span className="small">합성 자료만 사용 · 서버에 저장되지 않음</span>
      <span className="spacer grow" />
      <label className="row small">
        데모 시각
        <select value={demo.clockId} onChange={(e) => demo.setClock(e.target.value)} style={{ width: 'auto', minHeight: 36 }}>
          {DEMO_CLOCKS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </label>
      <label className="row small">
        다음 제출
        <select value={demo.failure} onChange={(e) => demo.setFailure(e.target.value as DemoFailure)} style={{ width: 'auto', minHeight: 36 }}>
          <option value="none">정상</option>
          <option value="upload">업로드 실패</option>
          <option value="confirm_lost">확정 응답 유실</option>
        </select>
      </label>
      <button className="btn sm" onClick={leaveDemo}>데모 처음부터</button>
    </div>
  );
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    load().then(
      (v) => { if (alive) { setData(v); setError(null); setLoading(false); } },
      (e) => { if (alive) { setError(e); setLoading(false); } },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return { data, error, loading, reload: () => setVersion((v) => v + 1), setData };
}
