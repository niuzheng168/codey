// A task/probe owns its complete process tree, including native Codex children.
// Closing the job (also when Task Scheduler terminates the supervisor) kills it.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

// A GUI-subsystem entrypoint avoids creating a console (and Windows Terminal
// window) before PowerShell can process -WindowStyle Hidden.
public static class CodeyTaskHost
{
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || !Path.IsPathRooted(args[0]) ||
                (args[1] != "codey" && args[1] != "tunnel" && args[1] != "renew")) return 1;
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            var info = new ProcessStartInfo(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                    @"System32\WindowsPowerShell\v1.0\powershell.exe"),
                "-NoLogo -NoProfile -NonInteractive -File " +
                Quote(Path.Combine(directory, "windows-service.ps1")) +
                " -ConfigPath " + Quote(args[0]) + " -Component " + Quote(args[1]));
            info.WorkingDirectory = directory;
            foreach (string name in new string[] {
                "PSModulePath", "CODEX_THREAD_ID", "CODEX_PARENT_THREAD_ID",
                "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"
            }) info.EnvironmentVariables.Remove(name);
            using (var child = new CodeyBackgroundProcess(info, null, null))
            {
                child.Process.WaitForExit();
                child.Drain();
                // The watchdog is an endless loop. Even a clean exit is a
                // failure for Task Scheduler's RestartOnFailure policy.
                return child.Process.ExitCode == 0 ? 1 : child.Process.ExitCode;
            }
        }
        catch { return 1; } // Never expose paths, arguments or credentials.
    }

    private static string Quote(string value)
    {
        if (value.IndexOfAny(new char[] { '\0', '\r', '\n', '"' }) >= 0)
            throw new ArgumentException("Invalid task argument.");
        return "\"" + value + "\"";
    }
}

// Stream logs on native .NET threads, not PowerShell event callbacks. This
// prevents a blocking WaitForExit from leaving logs empty or pipes full.
public sealed class CodeyBackgroundProcess : IDisposable
{
    public Process Process { get; private set; }
    private CodeyChildJob job;
    private Stream stdout, stderr;
    private Task stdoutCopy, stderrCopy;

    public CodeyBackgroundProcess(ProcessStartInfo info, string stdoutPath, string stderrPath)
    {
        try
        {
            stdout = OpenLog(stdoutPath);
            stderr = OpenLog(stderrPath);
            job = new CodeyChildJob();
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            Process = new Process();
            Process.StartInfo = info;
            Process.Start();
            job.Add(Process);
            Process.StandardInput.Close(); // A daemon must never wait for login input.
            stdoutCopy = Process.StandardOutput.BaseStream.CopyToAsync(stdout);
            stderrCopy = Process.StandardError.BaseStream.CopyToAsync(stderr);
        }
        catch { Dispose(); throw; }
    }

    private static Stream OpenLog(string path)
    {
        if (String.IsNullOrEmpty(path)) return Stream.Null;
        // Keep the previous crash instead of truncating it on every retry.
        if (File.Exists(path) && new FileInfo(path).Length > 10 * 1024 * 1024)
        {
            File.Copy(path, path + ".previous", true);
            File.WriteAllBytes(path, new byte[0]);
        }
        return new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite,
            1, FileOptions.Asynchronous | FileOptions.WriteThrough);
    }

    public void Drain()
    {
        if (stdoutCopy != null) stdoutCopy.GetAwaiter().GetResult();
        if (stderrCopy != null) stderrCopy.GetAwaiter().GetResult();
        stdout.Flush();
        stderr.Flush();
    }

    public void Dispose()
    {
        if (job != null) { job.Dispose(); job = null; }
        if (Process != null)
        {
            try { Process.WaitForExit(5000); } catch (InvalidOperationException) { }
        }
        try { Drain(); } catch { }
        if (stdout != null) { stdout.Dispose(); stdout = null; }
        if (stderr != null) { stderr.Dispose(); stderr = null; }
        if (Process != null) { Process.Dispose(); Process = null; }
    }
}

public sealed class CodeyChildJob : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    private IntPtr handle;

    public CodeyChildJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int length = Marshal.SizeOf(limits);
        IntPtr memory = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(limits, memory, false);
            if (!SetInformationJobObject(handle, 9, memory, (uint)length))
            {
                int error = Marshal.GetLastWin32Error();
                Dispose();
                throw new Win32Exception(error);
            }
        }
        finally { Marshal.FreeHGlobal(memory); }
    }
    public void Add(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle))
        {
            int error = Marshal.GetLastWin32Error();
            try { process.Kill(); } catch (InvalidOperationException) { }
            throw new Win32Exception(error);
        }
    }
    public void Dispose()
    {
        if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
        GC.SuppressFinalize(this);
    }
    ~CodeyChildJob() { Dispose(); }
}
