#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 5) return 94;
  const char *output = getenv("HARNESS_OUTPUT");
  if (output == NULL) return 95;
  size_t output_length = (size_t)snprintf(NULL, 0, "HARNESS_OUTPUT=%s", output) + 1;
  size_t duplicate_length = (size_t)snprintf(NULL, 0, "%s=%s", argv[3], argv[4]) + 1;
  char *output_entry = malloc(output_length);
  char *first = malloc(duplicate_length);
  char *second = malloc(duplicate_length);
  if (output_entry == NULL || first == NULL || second == NULL) return 96;
  snprintf(output_entry, output_length, "HARNESS_OUTPUT=%s", output);
  snprintf(first, duplicate_length, "%s=%s", argv[3], argv[4]);
  snprintf(second, duplicate_length, "%s=%s", argv[3], argv[4]);
  char *const launcher_argv[] = { argv[1], argv[2], NULL };
  char *const environment[] = {
    first,
    second,
    output_entry,
    NULL
  };
  execve(argv[1], launcher_argv, environment);
  return 97;
}
