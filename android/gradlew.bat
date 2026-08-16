@rem Standard Gradle wrapper launcher script for Windows.
@rem See gradlew for notes on generating gradle-wrapper.jar / gradle-wrapper.properties first.
@echo off
setlocal

set APP_HOME=%~dp0
set WRAPPER_JAR=%APP_HOME%gradle\wrapper\gradle-wrapper.jar

if not exist "%WRAPPER_JAR%" (
    echo gradle-wrapper.jar not found. Run "gradle wrapper --gradle-version 8.7" once, or use a system-installed gradle.
    exit /b 1
)

if defined JAVA_HOME (
    set JAVA_EXE=%JAVA_HOME%\bin\java.exe
) else (
    set JAVA_EXE=java.exe
)

"%JAVA_EXE%" -cp "%WRAPPER_JAR%" org.gradle.wrapper.GradleWrapperMain %*
