// ax_probe: print Bluebook's question navigator, answer options, text fields
// and section labels as "role<US>description<US>value" lines, through the
// macOS Accessibility API directly. The AppleScript version took >10 s for
// ~400 elements; this walks the same tree natively. Reads only.
//
//   ax_probe <bluebook pid>   (prints every labelled control and static text)
// First line instead, when there is nothing to read:
//   BACK   Bluebook is not the focused application
//   NOWIN  Bluebook has no window visible to Accessibility
//   NOAX   this process has no Accessibility permission
//
// Build: clang -O2 -framework ApplicationServices -o ax_probe ax_probe.c
// (C, not Swift: the Command Line Tools' Swift compiler and SDK disagree on
// this Mac, so AppKit cannot be imported.)
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int visited = 0;

static void put_text(CFTypeRef v) {
    if (!v) return;
    if (CFGetTypeID(v) == CFStringGetTypeID()) {
        CFIndex n = CFStringGetMaximumSizeForEncoding(CFStringGetLength((CFStringRef)v), kCFStringEncodingUTF8) + 1;
        char *buf = malloc(n);
        if (buf && CFStringGetCString((CFStringRef)v, buf, n, kCFStringEncodingUTF8)) {
            for (char *p = buf; *p; p++) if (*p == '\n' || *p == '\r' || *p == 0x1f || *p == 0x1e) *p = ' ';
            fputs(buf, stdout);
        }
        free(buf);
    } else if (CFGetTypeID(v) == CFNumberGetTypeID()) {
        double d = 0;
        CFNumberGetValue((CFNumberRef)v, kCFNumberDoubleType, &d);
        if (d == (long)d) printf("%ld", (long)d); else printf("%g", d);
    } else if (CFGetTypeID(v) == CFBooleanGetTypeID()) {
        fputs(CFBooleanGetValue((CFBooleanRef)v) ? "1" : "0", stdout);
    }
}

static CFTypeRef copy_attr(AXUIElementRef el, CFStringRef name) {
    CFTypeRef v = NULL;
    if (AXUIElementCopyAttributeValue(el, name, &v) != kAXErrorSuccess) return NULL;
    return v;
}

static void walk(AXUIElementRef el, int depth) {
    if (++visited > 20000 || depth > 80) return;
    CFTypeRef role = copy_attr(el, kAXRoleAttribute);
    if (role && CFGetTypeID(role) == CFStringGetTypeID()) {
        // Every labelled control and every piece of static text, in tree order:
        // the tracker picks out the navigator, options, stem and passage itself.
        int wanted = CFEqual(role, CFSTR("AXButton")) || CFEqual(role, CFSTR("AXRadioButton"))
                  || CFEqual(role, CFSTR("AXStaticText")) || CFEqual(role, CFSTR("AXTextField"))
                  || CFEqual(role, CFSTR("AXCheckBox"));
        if (wanted) {
            CFTypeRef desc = copy_attr(el, kAXDescriptionAttribute);
            CFTypeRef value = copy_attr(el, kAXValueAttribute);
            int has_desc = desc && CFGetTypeID(desc) == CFStringGetTypeID() && CFStringGetLength((CFStringRef)desc) > 0;
            int has_value = value && ((CFGetTypeID(value) == CFStringGetTypeID() && CFStringGetLength((CFStringRef)value) > 0)
                                      || CFGetTypeID(value) == CFNumberGetTypeID() || CFGetTypeID(value) == CFBooleanGetTypeID());
            if (has_desc || has_value) {
                put_text(role); putchar(0x1f); if (has_desc) put_text(desc); putchar(0x1f); if (has_value) put_text(value); putchar('\n');
            }
            if (desc) CFRelease(desc);
            if (value) CFRelease(value);
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

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: ax_probe <pid>\n"); return 2; }
    pid_t pid = (pid_t)atoi(argv[1]);
    if (!AXIsProcessTrusted()) { puts("NOAX"); return 0; }

    // Ask the app itself whether it is frontmost (what AppleScript's `frontmost`
    // reads). The system-wide focused-application attribute answered wrongly
    // when run from a non-GUI shell.
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    CFTypeRef front = copy_attr(app, kAXFrontmostAttribute);
    int is_front = front && CFGetTypeID(front) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)front);
    if (front) CFRelease(front);
    if (!is_front) { puts("BACK"); return 0; }

    CFTypeRef windows = copy_attr(app, kAXWindowsAttribute);
    if (!windows || CFGetTypeID(windows) != CFArrayGetTypeID() || CFArrayGetCount((CFArrayRef)windows) == 0) {
        puts("NOWIN"); return 0;
    }
    walk((AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)windows, 0), 0);
    return 0;
}
