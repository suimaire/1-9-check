import { BackendError } from './backend/types.ts';

const MESSAGES: Record<string, string> = {
  network: '서버와 연결되지 않았습니다. 접수되지 않았습니다. 연결을 확인하고 다시 시도해 주세요.',
  invalid_credentials: '아이디 또는 비밀번호가 맞지 않습니다.',
  too_many_attempts: '시도가 너무 많습니다. 15분 뒤 다시 시도해 주세요.',
  invalid_student_no: '1-9반 학번을 확인해 주세요.',
  already_submitted: '이미 제출된 기록입니다. 다른 기기에서 수정하려면 담임교사에게 알려 주세요.',
  unauthorized: '로그인이 필요합니다. 다시 로그인해 주세요.',
  bad_request: '요청 내용이 올바르지 않습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  not_allowed: '이 작업을 할 권한이 없습니다.',
  no_profile: '이 계정에는 사용 권한이 없습니다. 담임 선생님께 문의해 주세요.',
  wrong_password: '현재 비밀번호가 맞지 않습니다.',
  weak_password: '새 비밀번호는 영문과 숫자를 섞어 8자 이상으로 정해 주세요.',
  same_password: '새 비밀번호가 현재 비밀번호와 같습니다.',
  date_out_of_range: '운영 기간 밖의 날짜는 제출할 수 없습니다.',
  not_target_day: '이 날짜는 수집 대상이 아닙니다.',
  not_on_roster: '이 날짜는 제출 대상 명단에 포함되지 않습니다.',
  window_not_open: '아직 하루가 끝나지 않은 날짜입니다. 다음 날 00:00부터 제출할 수 있습니다.',
  window_closed: '제출 허용 기간이 끝났습니다.',
  version_conflict: '다른 기기에서 먼저 제출 내용이 바뀌었습니다. 새로고침 후 확인해 주세요.',
  object_missing: '업로드된 이미지를 찾지 못했습니다. 사진을 다시 선택해 제출해 주세요.',
  object_not_owned: '이미지 확인에 실패했습니다. 사진을 다시 선택해 제출해 주세요.',
  path_reused: '이미 사용한 업로드입니다. 사진을 다시 선택해 제출해 주세요.',
  bad_path: '이미지 경로가 올바르지 않습니다. 다시 시도해 주세요.',
  bad_type: 'JPEG, PNG, WebP 이미지만 제출할 수 있습니다.',
  too_large: '사진 한 장이 2MB를 넘습니다. 필요한 부분만 잘라서 다시 선택해 주세요.',
  upload_failed: '사진 업로드에 실패했습니다. 접수되지 않았습니다. 다시 시도해 주세요.',
  no_image: '사진을 1장 이상 선택해 주세요.',
  too_many_images: '사진은 최대 3장까지 제출할 수 있습니다.',
  bad_minutes: '총 사용 시간은 0~1440분 사이의 정수로 입력해 주세요.',
  note_too_long: '메모는 100자까지 쓸 수 있습니다.',
  stale_version: '학생이 그 사이 새 사진으로 교체했습니다. 새 사진을 다시 확인해 주세요.',
  message_required: '학생에게 보일 수정 요청 문구를 입력해 주세요.',
  message_too_long: '수정 요청 문구는 200자까지 쓸 수 있습니다.',
  deadline_locked: '이미 제출 창이 열린 날짜의 마감은 바꿀 수 없습니다.',
  range_has_data: '기간을 줄이면 이미 기록이 있는 날짜가 빠집니다. 기간을 다시 확인해 주세요.',
  bad_range: '운영 시작일과 마지막 기록일을 확인해 주세요(최대 121일).',
  bad_deadline: '마감 시각을 확인해 주세요.',
  final_before_deadline: '마지막 제출 허용 시각은 마지막 기록일 마감 이후여야 합니다.',
  confirm_mismatch: '확인용 운영 기간 이름이 일치하지 않습니다.',
  duplicate_student_no: '같은 학번이 이미 명단에 있습니다.',
  demo_term_fixed: '데모에서는 새 운영 기간을 만들 수 없습니다.',
  not_found: '자료를 찾지 못했습니다.',
  server_error: '서버 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.',
};

export function errorMessage(err: unknown): string {
  if (err instanceof BackendError) return MESSAGES[err.code] ?? MESSAGES.server_error;
  if (err instanceof Error && err.message && !/^[a-z_]+$/.test(err.message)) return err.message;
  return MESSAGES.server_error;
}
