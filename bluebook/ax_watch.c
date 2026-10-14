// ax_watch: long-running reader for the Bluebook tracker.
//
// The one-shot ax_probe is run every 1-2 s, so an answer changed in the last
// moment before "Next" was lost (4 questions in Practice 11, 2026-10-13).
// This process keeps running instead:
//   - every FULL_MS it walks the window and prints a full snapshot block
//       S\n <role US desc US value lines> \nE
//   - between walks, every FAST_MS, it re-reads only the elements that carry
//     the answer (the option radio buttons, any text field) and the question
//     navigator button, using the references found by the last walk, and
//     prints a line as soon as one of them changes:
//       D US <desc> US <value>
//   - when Bluebook is not frontmost / has no window it prints BACK or NOWIN
//     and waits SLOW_MS; without Accessibility permission it prints NOAX and
//     exits; when the process is gone it exits with NOPROC.
// Reads only: nothing is clicked, typed or captured.
//
//   ax_watch <bluebook pid>
// Build: clang -O2 -framework ApplicationServices -o ax_watch ax_watch.c
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define FULL_MS 1000
#define FAST_MS 150
#define SLOW_MS 2000
#define MAX_TRACKED 16

static CFTypeRef copy_attr(AXUIElementRef el, CFStringRef name) {
    CFTypeRef v = NULL;
    if (AXUIElementCopyAttributeValue(el, name, &v) != kAXErrorSuccess) return NULL;
    return v;
}

// value -> malloc'd UTF-8 text ("" when absent); newlines and separators flattened
static char *text_of(CFTypeRef v) {
    if (!v) return strdup("");
    if (CFGetTypeID(v) == CFStringGetTypeID()) {
        CFIndex n = CFStringGetMaximumSizeForEncoding(CFStringGetLength((CFStringRef)v), kCFStringEncodingUTF8) + 1;
        char *buf = malloc(n);
        if (!buf || !CFStringGetCString((CFStringRef)v, buf, n, kCFStringEncodingUTF8)) { free(buf); return strdup(""); }
        for (char *p = buf; *p; p++) if (*p == '\n' || *p == '\r' || *p == 0x1f || *p == 0x1e) *p = ' ';
        return buf;
    }
    char buf[64] = "";
    if (CFGetTypeID(v) == CFNumberGetTypeID()) {
        double d = 0;
        CFNumberGetValue((CFNumberRef)v, kCFNumberDoubleType, &d);
        if (d == (long)d) snprintf(buf, sizeof buf, "%ld", (long)d); else snprintf(buf, sizeof buf, "%g", d);
    } else if (CFGetTypeID(v) == CFBooleanGetTypeID()) {
        strcpy(buf, CFBooleanGetValue((CFBooleanRef)v) ? "1" : "0");
    }
    return strdup(buf);
}

static char *attr_text(AXUIElementRef el, CFStringRef name) {
    CFTypeRef v = copy_attr(el, name);
    char *s = text_of(v);
    if (v) CFRelease(v);
    return s;
}

// Elements re-read between walks: options, text fields, the navigator button.
static AXUIElementRef tracked[MAX_TRACKED];
static char *tracked_desc[MAX_TRACKED];
static char *tracked_last[MAX_TRACKED];
static int ntracked = 0;
static int visited = 0;

static void drop_tracked(void) {
    for (int i = 0; i < ntracked; i++) {
        CFRelease(tracked[i]); free(tracked_desc[i]); free(tracked_last[i]);
    }
    ntracked = 0;
}

static void walk(AXUIElementRef el, int depth) {
    if (++visited > 20000 || depth > 80) return;
    CFTypeRef role = copy_attr(el, kAXRoleAttribute);
    if (role && CFGetTypeID(role) == CFStringGetTypeID()) {
        int is_radio = CFEqual(role, CFSTR("AXRadioButton"));
        int is_field = CFEqual(role, CFSTR("AXTextField"));
        int is_button = CFEqual(role, CFSTR("AXButton"));
        int wanted = is_radio || is_field || is_button || CFEqual(role, CFSTR("AXStaticText")) || CFEqual(role, CFSTR("AXCheckBox"));
        if (wanted) {
            char *desc = attr_text(el, kAXDescriptionAttribute);
            char *value = attr_text(el, kAXValueAttribute);
            if (*desc || *value) {
                char *r = text_of(role);
                printf("%s\x1f%s\x1f%s\n", r, desc, value);
                free(r);
            }
            int is_nav = is_button && strncmp(desc, "Question Navigator", 18) == 0;
            if ((is_radio || is_field || is_nav) && ntracked < MAX_TRACKED) {
                CFRetain(el);
                tracked[ntracked] = el;
                tracked_desc[ntracked] = desc;
                tracked_last[ntracked] = value;
                ntracked++;
            } else {
                free(desc); free(value);
            }
        }
    }
    if (role) CFRelease(role);
    CFTypeRef children = copy_attr(el, kAXChildrenAttribute);
    if (children && CFGetTypeID(children) == CFArrayGetTypeID()) {
        CFIndex n = CFArrayGetCount((CFArrayRef)children);
        for (CFIndex i = 0; i < n; i++)
            walk((AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)children, i), depth + 1);
    }
    if (children) CFRelease(children);
}

static int frontmost(AXUIElementRef app) {
    CFTypeRef front = copy_attr(app, kAXFrontmostAttribute);
    int is_front = front && CFGetTypeID(front) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)front);
    if (front) CFRelease(front);
    return is_front;
}

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: ax_watch <pid>\n"); return 2; }
    pid_t pid = (pid_t)atoi(argv[1]);
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (!AXIsProcessTrusted()) { puts("NOAX"); return 0; }
    AXUIElementRef app = AXUIElementCreateApplication(pid);

    for (;;) {
        if (kill(pid, 0) != 0) { puts("NOPROC"); return 0; }
        if (!frontmost(app)) {
            drop_tracked();
            puts("BACK");
            usleep(SLOW_MS * 1000);
            continue;
        }
        CFTypeRef windows = copy_attr(app, kAXWindowsAttribute);
        if (!windows || CFGetTypeID(windows) != CFArrayGetTypeID() || CFArrayGetCount((CFArrayRef)windows) == 0) {
            if (windows) CFRelease(windows);
            drop_tracked();
            puts("NOWIN");
            usleep(SLOW_MS * 1000);
            continue;
        }
        // full snapshot
        drop_tracked();
        visited = 0;
        puts("S");
        walk((AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)windows, 0), 0);
        puts("E");
        CFRelease(windows);

        // fast re-reads until the next full walk
        long until = now_ms() + FULL_MS;
        while (now_ms() < until) {
            usleep(FAST_MS * 1000);
            for (int i = 0; i < ntracked; i++) {
                char *value = attr_text(tracked[i], kAXValueAttribute);
                char *desc = tracked_desc[i];
                if (strncmp(desc, "Question Navigator", 18) == 0) {
                    // the button's description carries the question number
                    free(value);
                    value = attr_text(tracked[i], kAXDescriptionAttribute);
                    if (strcmp(value, desc) != 0) {
                        printf("D\x1f%s\x1f%s\n", "nav", value);
                        free(tracked_desc[i]); tracked_desc[i] = strdup(value);
                    }
                    free(value);
                    continue;
                }
                if (strcmp(value, tracked_last[i]) != 0) {
                    printf("D\x1f%s\x1f%s\n", desc, value);
                    free(tracked_last[i]); tracked_last[i] = value;
                } else {
                    free(value);
                }
            }
        }
    }
}
