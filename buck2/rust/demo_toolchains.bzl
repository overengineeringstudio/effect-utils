"""Prelude demo registrations with Rust/C++ replaced by exact Nix providers.

Keep this declaration set aligned with the Prelude bundled by nix/buck2.nix.
Prelude's demo macro intentionally recommends copying it for real projects.
"""

load("@effect_utils//buck2/rust:toolchains.bzl", "native_rust_toolchains")
load("@prelude//android/tools:jdk_system_image.bzl", "jdk_system_image")
load("@prelude//tests:test_toolchain.bzl", "noop_test_toolchain")
load("@prelude//toolchains:android.bzl", "android_sdk_tools", "system_android_toolchain")
load("@prelude//toolchains:demo.bzl", "android_hack_alias")
load("@prelude//toolchains:dex.bzl", "system_dex_toolchain", "system_noop_dex_toolchain")
load("@prelude//toolchains:erlang.bzl", "system_erlang_toolchain")
load("@prelude//toolchains:genrule.bzl", "system_genrule_toolchain")
load("@prelude//toolchains:haskell.bzl", "system_haskell_toolchain")
load(
    "@prelude//toolchains:java.bzl",
    "java_test_toolchain",
    "javacd_toolchain",
    "system_java_bootstrap_toolchain",
    "system_java_lib",
    "system_java_tool",
    "system_prebuilt_jar_bootstrap_toolchain",
)
load("@prelude//toolchains:kotlin.bzl", "kotlincd_toolchain", "system_kotlin_bootstrap_toolchain")
load("@prelude//toolchains:ocaml.bzl", "system_ocaml_toolchain")
load("@prelude//toolchains:python.bzl", "remote_python_toolchain", "system_python_wheel_toolchain")
load("@prelude//toolchains:remote_test_execution.bzl", "remote_test_execution_toolchain")
load("@prelude//toolchains:zip_file.bzl", "zip_file_toolchain")
load("@prelude//toolchains/go:system_go_bootstrap_toolchain.bzl", "system_go_bootstrap_toolchain")
load("@prelude//toolchains/go:system_go_toolchain.bzl", "system_go_toolchain")


def configured_demo_toolchains(capabilities, generation, target_platform):
    """Declares the bundled demo surface with configured native Rust/C++."""
    android_sdk_tools(
        name = "android_sdk_tools",
        visibility = ["PUBLIC"],
    )

    jdk_system_image(
        name = "jdk_system_image",
        core_for_system_modules_jar = ":android_sdk_tools[core-for-system-modules.jar]",
    )

    system_android_toolchain(
        name = "android",
        android_sdk_tools_target = ":android_sdk_tools",
        jdk_system_image = ":jdk_system_image",
        visibility = ["PUBLIC"],
    )

    native_rust_toolchains(
        capabilities = capabilities,
        generation = generation,
        target_platform = target_platform,
    )

    android_hack_alias(
        name = "android-hack",
        actual = ":cxx",
        visibility = ["PUBLIC"],
    )

    system_dex_toolchain(
        name = "dex",
        android_sdk_tools_target = ":android_sdk_tools",
        visibility = ["PUBLIC"],
    )

    system_noop_dex_toolchain(
        name = "empty_dex",
        visibility = ["PUBLIC"],
    )

    system_genrule_toolchain(
        name = "genrule",
        visibility = ["PUBLIC"],
    )

    system_go_toolchain(
        name = "go",
        visibility = ["PUBLIC"],
    )

    system_go_bootstrap_toolchain(
        name = "go_bootstrap",
        visibility = ["PUBLIC"],
    )

    system_haskell_toolchain(
        name = "haskell",
        visibility = ["PUBLIC"],
    )

    javacd_toolchain(
        name = "java",
        java = ":java_tool",
        javac = ":javac_tool",
        jar = ":jar_tool",
        jlink = ":jlink_tool",
        jmod = ":jmod_tool",
        jrt_fs_jar = ":jrt_fs_jar",
        visibility = ["PUBLIC"],
    )

    system_java_bootstrap_toolchain(
        name = "java_bootstrap",
        java = ":java_tool",
        javac = ":javac_tool",
        jlink = ":jlink_tool",
        jmod = ":jmod_tool",
        jrt_fs_jar = ":jrt_fs_jar",
        visibility = ["PUBLIC"],
    )

    javacd_toolchain(
        name = "java_for_android",
        java = ":java_tool",
        javac = ":javac_tool",
        jar = ":jar_tool",
        jlink = ":jlink_tool",
        jmod = ":jmod_tool",
        jrt_fs_jar = ":jrt_fs_jar",
        visibility = ["PUBLIC"],
    )

    javacd_toolchain(
        name = "java_for_host_test",
        java = ":java_tool",
        javac = ":javac_tool",
        java_for_tests = ":java_tool",
        jar = ":jar_tool",
        jlink = ":jlink_tool",
        jmod = ":jmod_tool",
        jrt_fs_jar = ":jrt_fs_jar",
        visibility = ["PUBLIC"],
    )

    java_test_toolchain(
        name = "java_test",
        visibility = ["PUBLIC"],
    )

    java_home = read_root_config("java", "java_home", "/usr/local/java-runtime/impl/17")
    system_java_tool(
        name = "java_tool",
        tool_name = java_home + "/bin/java",
        visibility = ["PUBLIC"],
    )

    system_java_tool(
        name = "javac_tool",
        tool_name = java_home + "/bin/javac",
        visibility = ["PUBLIC"],
    )

    system_java_tool(
        name = "jar_tool",
        tool_name = java_home + "/bin/jar",
        visibility = ["PUBLIC"],
    )

    system_java_tool(
        name = "jlink_tool",
        tool_name = java_home + "/bin/jlink",
        visibility = ["PUBLIC"],
    )

    system_java_tool(
        name = "jmod_tool",
        tool_name = java_home + "/bin/jmod",
        visibility = ["PUBLIC"],
    )

    system_java_lib(
        name = "jrt_fs_jar",
        jar = java_home + "/lib/jrt-fs.jar",
    )

    kotlincd_toolchain(
        name = "kotlin",
        visibility = ["PUBLIC"],
    )

    system_kotlin_bootstrap_toolchain(
        name = "kotlin_bootstrap",
        visibility = ["PUBLIC"],
    )

    kotlincd_toolchain(
        name = "kotlin_for_android",
        visibility = ["PUBLIC"],
    )

    system_ocaml_toolchain(
        name = "ocaml",
        visibility = ["PUBLIC"],
    )

    system_prebuilt_jar_bootstrap_toolchain(
        name = "prebuilt_jar",
        java = ":java_tool",
        visibility = ["PUBLIC"],
    )

    system_prebuilt_jar_bootstrap_toolchain(
        name = "prebuilt_jar_bootstrap",
        java = ":java_tool",
        visibility = ["PUBLIC"],
    )

    system_prebuilt_jar_bootstrap_toolchain(
        name = "prebuilt_jar_bootstrap_no_snapshot",
        java = ":java_tool",
        visibility = ["PUBLIC"],
    )

    remote_python_toolchain(
        name = "python",
        visibility = ["PUBLIC"],
    )

    system_python_wheel_toolchain(
        name = "python_wheel",
        visibility = ["PUBLIC"],
    )

    remote_test_execution_toolchain(
        name = "remote_test_execution",
        visibility = ["PUBLIC"],
    )

    noop_test_toolchain(
        name = "test",
        visibility = ["PUBLIC"],
    )

    zip_file_toolchain(
        name = "zip_file",
        visibility = ["PUBLIC"],
    )

    system_erlang_toolchain(
        name = "erlang-default",
        visibility = ["PUBLIC"],
    )
