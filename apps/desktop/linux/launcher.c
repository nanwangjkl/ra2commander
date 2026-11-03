#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* 静态启动器先清理覆盖层，再 exec Electron；动态库不能在进入此入口前执行。 */
static int remove_steam_overlay(void) {
    const char *preload = getenv("LD_PRELOAD");
    if (!preload || !*preload) return 0;
    char *copy = strdup(preload), *filtered = calloc(strlen(preload) + 1, 1), *save = NULL;
    if (!copy || !filtered) { free(copy); free(filtered); return -1; }
    size_t removed = 0;
    for (char *entry = strtok_r(copy, " :\t\r\n", &save); entry; entry = strtok_r(NULL, " :\t\r\n", &save)) {
        const char *name = strrchr(entry, '/');
        name = name ? name + 1 : entry;
        if (!strcmp(name, "gameoverlayrenderer.so") || !strcmp(name, "gameoverlayrenderer64.so")) { removed++; continue; }
        if (*filtered) strcat(filtered, ":");
        strcat(filtered, entry);
    }
    int result = 0;
    if (removed) {
        result = *filtered ? setenv("LD_PRELOAD", filtered, 1) : unsetenv("LD_PRELOAD");
        if (!result) fprintf(stderr, "[desktop] 已隔离 Steam 覆盖层预加载（%zu 项）\n", removed);
    }
    free(copy); free(filtered);
    return result;
}

int main(int argc, char **argv) {
    (void)argc;
    if (remove_steam_overlay()) { fprintf(stderr, "[desktop] 无法准备启动环境：%s\n", strerror(errno)); return 127; }
    char target[PATH_MAX];
    ssize_t length = readlink("/proc/self/exe", target, sizeof(target) - 1);
    if (length < 0 || (size_t)length >= sizeof(target) - 1) { fprintf(stderr, "[desktop] 无法定位启动器\n"); return 127; }
    target[length] = '\0';
    char *name = strrchr(target, '/');
    if (!name || (size_t)(name - target) + sizeof("/ra2commander.bin") > sizeof(target)) return 127;
    strcpy(name, "/ra2commander.bin");
    execv(target, argv);
    fprintf(stderr, "[desktop] 无法启动程序：%s\n", strerror(errno));
    return 127;
}
