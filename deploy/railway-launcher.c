#define _GNU_SOURCE
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

extern char **environ;

#ifndef RUN_ROOT
#define RUN_ROOT "/run/4lpha"
#endif
#ifndef RA_ROOT
#define RA_ROOT RUN_ROOT "/roles-anywhere"
#endif
#ifndef MANIFEST_PATH
#define MANIFEST_PATH RUN_ROOT "/manifest.json"
#endif
#ifndef CERTIFICATE_PATH
#define CERTIFICATE_PATH RA_ROOT "/certificate.pem"
#endif
#ifndef PRIVATE_KEY_PATH
#define PRIVATE_KEY_PATH RA_ROOT "/private-key.pem"
#endif
#ifndef ADAPTER_PATH
#define ADAPTER_PATH "/app/artifacts/billing-adapter.mjs"
#endif
#ifndef NODE_PATH
#define NODE_PATH "/usr/local/bin/node"
#endif
#ifndef API_PATH
#define API_PATH "/app/dist/railway/api.mjs"
#endif
#ifndef LP_PATH
#define LP_PATH "/app/dist/railway/lp-worker.mjs"
#endif
#ifndef VENUS_PATH
#define VENUS_PATH "/app/dist/railway/venus-worker.mjs"
#endif
#ifndef BILLING_PATH
#define BILLING_PATH "/app/dist/railway/billing-worker.mjs"
#endif
#define MAX_MANIFEST_ENCODED 1398104U
#define MAX_MANIFEST_DECODED 1048576U
#define MAX_PEM 16384U
#ifndef APP_UID
#define APP_UID 10001U
#endif
#ifndef APP_GID
#define APP_GID 10001U
#endif

static const char *const raw_names[] = {
  "BILLING_PRODUCTION_MANIFEST_BASE64",
  "BILLING_AWS_RA_CERTIFICATE_PEM",
  "BILLING_AWS_RA_PRIVATE_KEY_PEM"
};

static const char *const fixed_names[] = {
  "BILLING_PRODUCTION_MANIFEST_PATH",
  "BILLING_PRODUCTION_BUNDLE_PATH",
  "BILLING_AWS_RA_CERTIFICATE_PATH",
  "BILLING_AWS_RA_PRIVATE_KEY_PATH",
  "BILLING_RAILWAY_CLEAN_EXEC"
};

static void refuse(void) {
  fputs("railway launcher refused configuration\n", stderr);
  _exit(78);
}

static int env_name_equals(const char *entry, const char *name) {
  size_t length = strlen(name);
  return strncmp(entry, name, length) == 0 && entry[length] == '=';
}

static const char *unique_env(const char *name, int *present) {
  const char *result = NULL;
  *present = 0;
  for (size_t index = 0; environ[index] != NULL; index++) {
    if (!env_name_equals(environ[index], name)) continue;
    if (*present) refuse();
    *present = 1;
    result = strchr(environ[index], '=') + 1;
  }
  return result;
}

static int base64_value(unsigned char value) {
  if (value >= 'A' && value <= 'Z') return value - 'A';
  if (value >= 'a' && value <= 'z') return value - 'a' + 26;
  if (value >= '0' && value <= '9') return value - '0' + 52;
  if (value == '+') return 62;
  if (value == '/') return 63;
  return -1;
}

static unsigned char *decode_manifest(const char *encoded, size_t *decoded_length) {
  size_t length = strlen(encoded);
  if (length == 0 || length > MAX_MANIFEST_ENCODED || length % 4 != 0) refuse();
  size_t padding = 0;
  if (encoded[length - 1] == '=') padding++;
  if (encoded[length - 2] == '=') padding++;
  size_t output_length = (length / 4) * 3 - padding;
  if (output_length == 0 || output_length > MAX_MANIFEST_DECODED) refuse();
  unsigned char *output = malloc(output_length + 1);
  if (output == NULL) refuse();
  size_t out = 0;
  for (size_t index = 0; index < length; index += 4) {
    int a = base64_value((unsigned char)encoded[index]);
    int b = base64_value((unsigned char)encoded[index + 1]);
    int c = encoded[index + 2] == '=' ? 0 : base64_value((unsigned char)encoded[index + 2]);
    int d = encoded[index + 3] == '=' ? 0 : base64_value((unsigned char)encoded[index + 3]);
    int final = index + 4 == length;
    if (a < 0 || b < 0 || c < 0 || d < 0) refuse();
    if (!final && (encoded[index + 2] == '=' || encoded[index + 3] == '=')) refuse();
    if (final && ((padding == 0 && (encoded[index + 2] == '=' || encoded[index + 3] == '=')) ||
        (padding == 1 && (encoded[index + 2] == '=' || encoded[index + 3] != '=' || (c & 3) != 0)) ||
        (padding == 2 && (encoded[index + 2] != '=' || encoded[index + 3] != '=' || (b & 15) != 0)))) refuse();
    uint32_t block = ((uint32_t)a << 18) | ((uint32_t)b << 12) |
      ((uint32_t)c << 6) | (uint32_t)d;
    if (out < output_length) output[out++] = (unsigned char)(block >> 16);
    if (out < output_length) output[out++] = (unsigned char)(block >> 8);
    if (out < output_length) output[out++] = (unsigned char)block;
  }
  if (out != output_length || memchr(output, '\0', output_length) != NULL) refuse();
  output[output_length] = '\0';
  *decoded_length = output_length;
  return output;
}

struct json_cursor { const unsigned char *bytes; size_t length; size_t offset; };

static void json_expect(struct json_cursor *cursor, unsigned char value) {
  if (cursor->offset >= cursor->length || cursor->bytes[cursor->offset] != value) refuse();
  cursor->offset++;
}

static void json_string(struct json_cursor *cursor, const unsigned char **start, size_t *length, int *escaped) {
  json_expect(cursor, '"');
  *start = cursor->bytes + cursor->offset;
  *escaped = 0;
  while (cursor->offset < cursor->length) {
    unsigned char value = cursor->bytes[cursor->offset++];
    if (value == '"') {
      *length = (size_t)((cursor->bytes + cursor->offset - 1) - *start);
      return;
    }
    if (value < 0x20) refuse();
    if (value == '\\') {
      *escaped = 1;
      if (cursor->offset >= cursor->length) refuse();
      unsigned char escape = cursor->bytes[cursor->offset++];
      if (escape == 'u') {
        for (size_t index = 0; index < 4; index++) {
          if (cursor->offset >= cursor->length || !((cursor->bytes[cursor->offset] >= '0' && cursor->bytes[cursor->offset] <= '9') ||
              (cursor->bytes[cursor->offset] >= 'a' && cursor->bytes[cursor->offset] <= 'f') ||
              (cursor->bytes[cursor->offset] >= 'A' && cursor->bytes[cursor->offset] <= 'F'))) refuse();
          cursor->offset++;
        }
      } else if (strchr("\"\\/bfnrt", escape) == NULL) refuse();
    }
  }
  refuse();
}

static void json_exact_string(struct json_cursor *cursor, const char *expected) {
  const unsigned char *start;
  size_t length;
  int escaped;
  json_string(cursor, &start, &length, &escaped);
  if (escaped || length != strlen(expected) || memcmp(start, expected, length) != 0) refuse();
}

static void json_value(struct json_cursor *cursor, unsigned depth);

static void json_object(struct json_cursor *cursor, unsigned depth) {
  json_expect(cursor, '{');
  if (cursor->offset < cursor->length && cursor->bytes[cursor->offset] == '}') { cursor->offset++; return; }
  for (;;) {
    const unsigned char *start;
    size_t length;
    int escaped;
    json_string(cursor, &start, &length, &escaped);
    (void)start; (void)length; (void)escaped;
    json_expect(cursor, ':');
    json_value(cursor, depth + 1);
    if (cursor->offset < cursor->length && cursor->bytes[cursor->offset] == ',') { cursor->offset++; continue; }
    json_expect(cursor, '}');
    return;
  }
}

static void json_array(struct json_cursor *cursor, unsigned depth) {
  json_expect(cursor, '[');
  if (cursor->offset < cursor->length && cursor->bytes[cursor->offset] == ']') { cursor->offset++; return; }
  for (;;) {
    json_value(cursor, depth + 1);
    if (cursor->offset < cursor->length && cursor->bytes[cursor->offset] == ',') { cursor->offset++; continue; }
    json_expect(cursor, ']');
    return;
  }
}

static void json_value(struct json_cursor *cursor, unsigned depth) {
  if (depth > 64 || cursor->offset >= cursor->length) refuse();
  unsigned char value = cursor->bytes[cursor->offset];
  if (value == '"') {
    const unsigned char *start; size_t length; int escaped;
    json_string(cursor, &start, &length, &escaped);
    (void)start; (void)length; (void)escaped;
  } else if (value == '{') json_object(cursor, depth);
  else if (value == '[') json_array(cursor, depth);
  else if (value == 't' && cursor->offset + 4 <= cursor->length && memcmp(cursor->bytes + cursor->offset, "true", 4) == 0) cursor->offset += 4;
  else if (value == 'f' && cursor->offset + 5 <= cursor->length && memcmp(cursor->bytes + cursor->offset, "false", 5) == 0) cursor->offset += 5;
  else if (value == 'n' && cursor->offset + 4 <= cursor->length && memcmp(cursor->bytes + cursor->offset, "null", 4) == 0) cursor->offset += 4;
  else {
    size_t start = cursor->offset;
    if (value == '-') cursor->offset++;
    if (cursor->offset >= cursor->length) refuse();
    if (cursor->bytes[cursor->offset] == '0') cursor->offset++;
    else {
      if (cursor->bytes[cursor->offset] < '1' || cursor->bytes[cursor->offset] > '9') refuse();
      while (cursor->offset < cursor->length && cursor->bytes[cursor->offset] >= '0' && cursor->bytes[cursor->offset] <= '9') cursor->offset++;
    }
    if (cursor->offset < cursor->length && cursor->bytes[cursor->offset] == '.') {
      cursor->offset++;
      size_t fraction = cursor->offset;
      while (cursor->offset < cursor->length && cursor->bytes[cursor->offset] >= '0' && cursor->bytes[cursor->offset] <= '9') cursor->offset++;
      if (fraction == cursor->offset) refuse();
    }
    if (cursor->offset < cursor->length && (cursor->bytes[cursor->offset] == 'e' || cursor->bytes[cursor->offset] == 'E')) {
      cursor->offset++;
      if (cursor->offset < cursor->length && (cursor->bytes[cursor->offset] == '+' || cursor->bytes[cursor->offset] == '-')) cursor->offset++;
      size_t exponent = cursor->offset;
      while (cursor->offset < cursor->length && cursor->bytes[cursor->offset] >= '0' && cursor->bytes[cursor->offset] <= '9') cursor->offset++;
      if (exponent == cursor->offset) refuse();
    }
    if (start == cursor->offset) refuse();
  }
}

static void json_skip_member(struct json_cursor *cursor, const char *name, int comma) {
  json_exact_string(cursor, name);
  json_expect(cursor, ':');
  json_value(cursor, 1);
  if (comma) json_expect(cursor, ',');
}

static void json_credential(struct json_cursor *cursor) {
  static const char *const fields[] = { "trustAnchorArn", "profileArn", "certificateSha256",
    "certificateSubjectCn", "certificateIssuerCn", "helperVersion", "helperBytes", "helperSha256" };
  json_expect(cursor, '{');
  json_exact_string(cursor, "kind");
  json_expect(cursor, ':');
  json_exact_string(cursor, "roles-anywhere-x509-v1");
  for (size_t index = 0; index < 8; index++) {
    json_expect(cursor, ',');
    json_skip_member(cursor, fields[index], 0);
  }
  json_expect(cursor, '}');
}

static void json_aws(struct json_cursor *cursor) {
  static const char *const before[] = { "region", "accountId", "runtimeRoleArn" };
  static const char *const after[] = { "ticketKeyId", "ticketKeyArn", "x402KeyArn", "ogInference", "ogManagement" };
  json_expect(cursor, '{');
  for (size_t index = 0; index < 3; index++) json_skip_member(cursor, before[index], 1);
  json_exact_string(cursor, "credential");
  json_expect(cursor, ':');
  json_credential(cursor);
  for (size_t index = 0; index < 5; index++) {
    json_expect(cursor, ',');
    json_skip_member(cursor, after[index], 0);
  }
  json_expect(cursor, '}');
}

static void assert_roles_anywhere_manifest(const unsigned char *bytes, size_t length) {
  static const char *const before_aws[] = { "buildCommit", "sourceSha256", "lockSha256", "bundleSha256" };
  static const char *const after_aws[] = { "collector", "networks", "oracles", "caps", "postgres", "providers" };
  struct json_cursor cursor = { bytes, length, 0 };
  json_expect(&cursor, '{');
  json_exact_string(&cursor, "schema");
  json_expect(&cursor, ':');
  json_exact_string(&cursor, "4lpha.billing-production-manifest.v2");
  json_expect(&cursor, ',');
  for (size_t index = 0; index < 4; index++) json_skip_member(&cursor, before_aws[index], 1);
  json_exact_string(&cursor, "aws");
  json_expect(&cursor, ':');
  json_aws(&cursor);
  for (size_t index = 0; index < 6; index++) {
    json_expect(&cursor, ',');
    json_skip_member(&cursor, after_aws[index], 0);
  }
  json_expect(&cursor, '}');
  if (cursor.offset != cursor.length) refuse();
}

static void assert_pem(const char *value, const char *begin, const char *end) {
  size_t length = strlen(value);
  size_t begin_length = strlen(begin);
  size_t end_length = strlen(end);
  if (length == 0 || length > MAX_PEM || memchr(value, '\r', length) != NULL ||
      length < begin_length + end_length + 2 ||
      memcmp(value, begin, begin_length) != 0 || value[begin_length] != '\n') refuse();
  size_t terminal_lf = value[length - 1] == '\n' ? 1U : 0U;
  if (length < end_length + terminal_lf) refuse();
  size_t end_start = length - end_length - terminal_lf;
  size_t body_start = begin_length + 1;
  if (end_start <= body_start || memcmp(value + end_start, end, end_length) != 0 ||
      value[end_start - 1] != '\n') refuse();

  size_t body_end = end_start - 1;
  size_t line_start = body_start;
  size_t final_padding = 0;
  int final_value = -1;
  while (line_start < body_end) {
    size_t line_end = line_start;
    while (line_end < body_end && value[line_end] != '\n') line_end++;
    size_t line_length = line_end - line_start;
    int final_line = line_end == body_end;
    if (line_length == 0 || line_length > 64 || (!final_line && line_length != 64)) refuse();
    if (final_line && line_length % 4 != 0) refuse();

    size_t padding = 0;
    if (final_line && value[line_end - 1] == '=') padding++;
    if (final_line && line_length >= 2 && value[line_end - 2] == '=') padding++;
    if (padding > 2 || padding == line_length) refuse();
    for (size_t index = line_start; index < line_end - padding; index++) {
      int decoded = base64_value((unsigned char)value[index]);
      if (decoded < 0) refuse();
      if (final_line && index + 1 == line_end - padding) final_value = decoded;
    }
    for (size_t index = line_end - padding; index < line_end; index++) {
      if (value[index] != '=') refuse();
    }
    if (!final_line && padding != 0) refuse();
    if (final_line) final_padding = padding;
    line_start = line_end + 1;
  }
  if (line_start != body_end + 1 || final_value < 0 ||
      (final_padding == 1 && (final_value & 3) != 0) ||
      (final_padding == 2 && (final_value & 15) != 0)) refuse();
}

static void assert_run_root(void) {
  struct stat value;
  if (lstat(RUN_ROOT, &value) != 0 || !S_ISDIR(value.st_mode) || S_ISLNK(value.st_mode) ||
      value.st_uid != APP_UID || value.st_gid != APP_GID || (value.st_mode & 07777) != 0700) refuse();
}

static int write_new_file(const char *path, const unsigned char *bytes, size_t length) {
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, bytes + offset, length - offset);
    if (written <= 0) {
      close(fd);
      unlink(path);
      return -1;
    }
    offset += (size_t)written;
  }
  if (fsync(fd) != 0 || close(fd) != 0) {
    unlink(path);
    return -1;
  }
  return 0;
}

static char **clean_environment(const char *const raw_values[3]) {
  size_t count = 0;
  for (; environ[count] != NULL; count++) {}
  char **clean = calloc(count + 6, sizeof(char *));
  if (clean == NULL) return NULL;
  size_t out = 0;
  for (size_t index = 0; index < count; index++) {
    int raw = 0;
    for (size_t name = 0; name < 3; name++) {
      if (env_name_equals(environ[index], raw_names[name])) raw = 1;
      if (raw_values[name] != NULL && raw_values[name][0] != '\0' &&
          strstr(environ[index], raw_values[name]) != NULL) raw = 1;
    }
    if (!raw) clean[out++] = environ[index];
  }
  clean[out++] = "BILLING_PRODUCTION_MANIFEST_PATH=" MANIFEST_PATH;
  clean[out++] = "BILLING_PRODUCTION_BUNDLE_PATH=" ADAPTER_PATH;
  clean[out++] = "BILLING_AWS_RA_CERTIFICATE_PATH=" CERTIFICATE_PATH;
  clean[out++] = "BILLING_AWS_RA_PRIVATE_KEY_PATH=" PRIVATE_KEY_PATH;
  clean[out++] = "BILLING_RAILWAY_CLEAN_EXEC=1";
  clean[out] = NULL;
  return clean;
}

int main(int argc, char **argv) {
  if (argc != 2) refuse();
  if (geteuid() != APP_UID || getegid() != APP_GID) refuse();
  const char *role = argv[1];
  int is_api = strcmp(role, "api") == 0;
  int is_lp = strcmp(role, "lp-worker") == 0;
  int is_venus = strcmp(role, "venus-worker") == 0;
  int is_billing = strcmp(role, "billing-worker-once") == 0;
  if (!is_api && !is_lp && !is_venus && !is_billing) refuse();

  for (size_t index = 0; index < 5; index++) {
    int present;
    unique_env(fixed_names[index], &present);
    if (present) refuse();
  }
  int mode_present;
  const char *mode = unique_env("BILLING_ENABLED", &mode_present);
  int mode_off = !mode_present || mode[0] == '\0' || strcmp(mode, "off") == 0;
  int mode_report = mode_present && strcmp(mode, "report") == 0;
  int mode_on = mode_present && strcmp(mode, "on") == 0;
  if (!mode_off && !mode_report && !mode_on) refuse();

  const char *raw_values[3];
  int raw_present[3];
  for (size_t index = 0; index < 3; index++) {
    raw_values[index] = unique_env(raw_names[index], &raw_present[index]);
  }
  int raw_count = raw_present[0] + raw_present[1] + raw_present[2];

  if (is_lp || is_venus) {
    if (mode_on || raw_count != 0) refuse();
  } else if (is_billing) {
    if (!mode_on || raw_count != 3) refuse();
  } else if (is_api && mode_on) {
    if (raw_count != 3) refuse();
  } else if (raw_count != 0) {
    refuse();
  }

  char *const api_argv[] = { NODE_PATH, API_PATH, NULL };
  char *const lp_argv[] = { NODE_PATH, LP_PATH, NULL };
  char *const venus_argv[] = { NODE_PATH, VENUS_PATH, NULL };
  char *const billing_argv[] = { NODE_PATH, BILLING_PATH, "--once", NULL };

  if (!mode_on) {
    char *const *selected = is_api ? api_argv : (is_lp ? lp_argv : venus_argv);
    execve(selected[0], selected, environ);
    refuse();
  }

  size_t manifest_length;
  unsigned char *manifest = decode_manifest(raw_values[0], &manifest_length);
  assert_roles_anywhere_manifest(manifest, manifest_length);
  assert_pem(raw_values[1], "-----BEGIN CERTIFICATE-----", "-----END CERTIFICATE-----");
  assert_pem(raw_values[2], "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----");
  assert_run_root();
  umask(0077);
  if (mkdir(RA_ROOT, 0700) != 0) refuse();
  struct stat ra_root;
  if (lstat(RA_ROOT, &ra_root) != 0 || !S_ISDIR(ra_root.st_mode) || S_ISLNK(ra_root.st_mode) ||
      ra_root.st_uid != APP_UID || ra_root.st_gid != APP_GID || (ra_root.st_mode & 07777) != 0700) {
    rmdir(RA_ROOT);
    refuse();
  }
  int made_manifest = 0;
  int made_certificate = 0;
  int made_private_key = 0;
  if (write_new_file(MANIFEST_PATH, manifest, manifest_length) != 0) goto materialize_failed;
  made_manifest = 1;
  if (write_new_file(CERTIFICATE_PATH, (const unsigned char *)raw_values[1], strlen(raw_values[1])) != 0) goto materialize_failed;
  made_certificate = 1;
  if (write_new_file(PRIVATE_KEY_PATH, (const unsigned char *)raw_values[2], strlen(raw_values[2])) != 0) goto materialize_failed;
  made_private_key = 1;
  free(manifest);
  char **clean = clean_environment(raw_values);
  if (clean == NULL) goto materialize_failed;
  char *const *selected = is_api ? api_argv : billing_argv;
  execve(selected[0], selected, clean);
materialize_failed:
  if (made_private_key) unlink(PRIVATE_KEY_PATH);
  if (made_certificate) unlink(CERTIFICATE_PATH);
  if (made_manifest) unlink(MANIFEST_PATH);
  rmdir(RA_ROOT);
  refuse();
}
