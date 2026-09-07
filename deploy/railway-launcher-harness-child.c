#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern char **environ;

int main(int argc, char **argv) {
  const char *output = getenv("HARNESS_OUTPUT");
  if (output == NULL) return 90;
  for (size_t index = 0; environ[index] != NULL; index++) {
    if (strncmp(environ[index], "BILLING_PRODUCTION_MANIFEST_BASE64=", 35) == 0 ||
        strncmp(environ[index], "BILLING_AWS_RA_CERTIFICATE_PEM=", 31) == 0 ||
        strncmp(environ[index], "BILLING_AWS_RA_PRIVATE_KEY_PEM=", 31) == 0 ||
        strncmp(environ[index], "DUPLICATE_RAW_VALUE=", 20) == 0) return 91;
  }
  FILE *file = fopen(output, "wb");
  if (file == NULL) return 92;
  fprintf(file, "argc=%d", argc);
  for (int index = 0; index < argc; index++) fprintf(file, " argv%d=%s", index, argv[index]);
  fprintf(file, " clean=%s", getenv("BILLING_RAILWAY_CLEAN_EXEC") == NULL ? "absent" : getenv("BILLING_RAILWAY_CLEAN_EXEC"));
  if (fclose(file) != 0) return 93;
  return 0;
}
