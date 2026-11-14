package com.neurocapture.capturekit

import java.io.File

/** Finds files in the monorepo from a JVM test (the module may be reached through a node_modules symlink). */
object RepoFiles {
    fun find(relative: String): File {
        var dir: File? = File(".").canonicalFile
        while (dir != null) {
            val f = File(dir, relative)
            if (f.exists()) return f
            dir = dir.parentFile
        }
        throw IllegalStateException("$relative not found above ${File(".").canonicalPath}")
    }
}
