interface FinalizeResult {
  data: { replayed?: boolean } | null;
  error: { code?: string; message?: string } | null;
}

/** 응답 유실은 DB 롤백의 증거가 아니다. 확정 여부가 불명확한 파일은 보존한다. */
export async function finalizeImageUpload<T extends FinalizeResult>(
  commit: () => PromiseLike<T>, paths: string[], remove: (paths: string[]) => PromiseLike<unknown>,
): Promise<T> {
  const result = await commit();
  if (result.data?.replayed || result.error?.code === 'P0001') {
    try { await remove(paths); } catch { /* 정리 실패는 나중에 고아 파일 정리에서 재시도한다. */ }
  }
  return result;
}
