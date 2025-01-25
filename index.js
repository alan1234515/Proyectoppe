import express from "express";
import path from "path";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid"; // Para generar identificadores únicos
import { fileURLToPath } from "url";
import multer from "multer"; // Para manejo de archivos
import fs from "fs";


// Obtener la ruta del directorio actual
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Crear la carpeta de uploads si no existe
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
// Desestructuración de Pool desde el módulo CommonJS de pg
const { Pool } = pkg;

// Configuración de variables de entorno
dotenv.config();



const app = express();

// Conexión a la base de datos usando la URL de DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Necesario si estás usando Render (servidores con SSL)
  },
});

// Middleware para manejar cookies
app.use(cookieParser());

console.log(path.join(__dirname, "uploads"));
// Ruta para mostrar el index y registrar visitas
// Ruta principal: registro de visitas únicas
app.get("/", async (req, res) => {
  try {
    // 1. Identificar al usuario por cookie
    let visitId = req.cookies["visitId"];

    if (!visitId) {
      // 2. Si no hay cookie, generar un ID único y crear la cookie
      visitId = uuidv4();
      res.cookie("visitId", visitId, { maxAge: 86400000, httpOnly: true }); // 1 día
    }

    // 3. Verificar si ya existe en la base de datos
    const checkUserQuery = "SELECT 1 FROM visitas WHERE visitante_id = $1";
    const result = await pool.query(checkUserQuery, [visitId]);

    if (result.rows.length === 0) {
      // Registrar la primera visita del usuario
      const userIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      const insertVisitQuery =
        "INSERT INTO visitas (visitante_id, ip) VALUES ($1, $2)";
      await pool.query(insertVisitQuery, [visitId, userIp]);
    }

    // Contar el total de visitas
    const totalQuery = "SELECT COUNT(*) AS total_visitas FROM visitas";
    const totalResult = await pool.query(totalQuery);
    const totalVisitas = totalResult.rows[0].total_visitas;

    res.send(`
      <html>
        <head><title>Contador de Visitas</title></head>
        <body>
          <h1>Total de visitas: ${totalVisitas}</h1>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Error en el registro de visitas:", error);
    res.status(500).send("Error interno del servidor.");
  }
});

// Ruta para obtener el total de visitas
app.get("/total-visitas", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*) AS total_visitas FROM visitas"
    );
    const totalVisitas = result.rows[0].total_visitas;
    res.json({ total_visitas: totalVisitas });
  } catch (error) {
    console.error("Error obteniendo el total de visitas:", error);
    res.status(500).json({ error: "Error obteniendo el total de visitas." });
  }
});

// Ruta para cargar el formulario de carga de libros
app.get("/forma1", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "forma1.html"));
});

// Ruta para mostrar el archivo categoria.html
app.get("/categorias", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "categoria.html"));
});

// Ruta para cargar la página de la forma 2
app.get("/forma2", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "forma2.html"));
});

// Configuración de multer para la carga de archivos (libros)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/"); // Carpeta donde se guardarán los archivos
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); // Nombre único para cada archivo
  },
});

const upload = multer({ storage: storage });

// Ruta para cargar libros
app.post("/cargar-libro", upload.single("archivo"), async (req, res) => {
  const { nombre, categoria } = req.body; // Tomamos nombre y categoría del formulario
  const archivoPath = req.file.path;

  try {
    const result = await pool.query(
      "INSERT INTO libros (nombre, categoria, archivo) VALUES ($1, $2, $3) RETURNING id",
      [nombre, categoria, archivoPath]
    );
    res.status(200).json({
      message: "Libro cargado con éxito",
      id: result.rows[0].id,
    });
  } catch (error) {
    console.error("Error al cargar el libro:", error);
    res.status(500).json({ error: "Error al cargar el libro." });
  }
});

// Ruta para obtener las categorías de libros
app.get("/categorias", async (req, res) => {
  try {
    const result = await pool.query("SELECT DISTINCT categoria FROM libros");
    res.json(result.rows);
  } catch (error) {
    console.error("Error obteniendo las categorías:", error);
    res.status(500).json({ error: "Error obteniendo las categorías." });
  }
});

// Rutas estáticas
app.use(express.static(path.join(__dirname, "public")));

// Ruta para obtener las categorías únicas (con cacheo)
let categoriasCache = [];
let cacheTimestamp = 0;
const CACHE_DURATION = 60000; // Cache por 1 minuto

app.get("/categorias/filtrar", async (req, res) => {
  const now = Date.now();

  // Verificar si el cache aún es válido
  if (categoriasCache.length > 0 && now - cacheTimestamp < CACHE_DURATION) {
    return res.json(categoriasCache); // Retornamos el cache si no ha expirado
  }

  try {
    const result = await pool.query(`
      SELECT DISTINCT categoria 
      FROM libros 
      UNION ALL
      SELECT DISTINCT categoria 
      FROM libros1
    `);

    // Almacenamos los resultados en el cache
    categoriasCache = result.rows;
    cacheTimestamp = now;

    res.json(categoriasCache);
  } catch (error) {
    console.error("Error obteniendo categorías:", error);
    res.status(500).json({ error: "Error obteniendo categorías." });
  }
});


// Ruta para obtener los libros de una categoría específica o todos si no se selecciona categoría
app.get("/categorias/libros", async (req, res) => {
  const { categoria } = req.query;

  try {
    let query;
    let params;

    if (categoria) {
      query = `
        (SELECT id, nombre, categoria, imagen, tipo_imagen, 'libros' AS origen FROM libros WHERE categoria = $1)
        UNION ALL
        (SELECT id, nombre, categoria, imagen, tipo_imagen, 'libros1' AS origen FROM libros1 WHERE categoria = $1)
      `;
      params = [categoria];
    } else {
      query = `
        (SELECT id, nombre, categoria, imagen, tipo_imagen, 'libros' AS origen FROM libros)
        UNION ALL
        (SELECT id, nombre, categoria, imagen, tipo_imagen, 'libros1' AS origen FROM libros1)
      `;
      params = [];
    }

    const result = await pool.query(query, params);

    // Aquí, si tus consultas son grandes, podrías agregar caché
    const libros = result.rows.map((libro) => ({
      ...libro,
      imagen: libro.imagen
        ? `data:${libro.tipo_imagen};base64,${libro.imagen.toString("base64")}`
        : null,
    }));

    res.json(libros);
  } catch (error) {
    console.error("Error obteniendo libros:", error);
    res.status(500).json({ error: "Error obteniendo libros." });
  }
});

// Ruta para descargar libros
app.get("/descargar/libros1/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const resultLibros1 = await pool.query(
      "SELECT nombre, archivo FROM libros1 WHERE id = $1",
      [id]
    );

    if (resultLibros1.rows.length > 0) {
      const libro = resultLibros1.rows[0];
      // Redirigir al enlace directo
      return res.redirect(libro.archivo);
    }

    return res.status(404).send("Libro no encontrado en libros1.");
  } catch (error) {
    console.error("Error al descargar el libro de libros1:", error);
    res.status(500).send("Error al descargar el libro.");
  }
});

// Ruta optimizada para descargar el archivo de un libro
app.get("/descargar/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Ejecutar las dos consultas en paralelo
    const [resultLibros1, resultLibros] = await Promise.all([
      pool.query("SELECT nombre, archivo FROM libros1 WHERE id = $1", [id]),
      pool.query(
        "SELECT nombre, archivo, tipo_archivo FROM libros WHERE id = $1",
        [id]
      ),
    ]);

    // Si el libro está en libros1 (tiene enlace directo), redirigimos al enlace
    if (resultLibros1.rows.length > 0) {
      const libro = resultLibros1.rows[0];
      return res.redirect(libro.archivo); // Redirección al enlace del archivo
    }

    // Si no se encuentra en libros1, verificamos si está en libros (archivos físicos)
    if (resultLibros.rows.length === 0) {
      return res.status(404).send("Libro no encontrado.");
    }

    const libro = resultLibros.rows[0];
    const archivo = path.join(__dirname, libro.archivo); // Ruta del archivo físico

    // Enviar el archivo para descargar
    res.sendFile(archivo);
  } catch (error) {
    console.error("Error al procesar la descarga del libro:", error);
    res.status(500).send("Error al procesar la descarga.");
  }
});
// Ruta para subir libro con imagen y enlace (segundo tipo de forma)
app.post("/subir-libro-forma2", upload.single("imagen"), async (req, res) => {
  const { nombre, categoria, enlace } = req.body;
  const archivo = req.file;

  // Validación de campos requeridos
  if (!nombre || !categoria || !enlace) {
    return res.status(400).json({ error: "Faltan campos requeridos." });
  }

  // Validación de tipo de imagen (ajusta según los tipos permitidos)
  if (archivo && !["image/jpeg", "image/png"].includes(archivo.mimetype)) {
    return res
      .status(400)
      .json({ error: "Solo se permiten imágenes JPEG y PNG." });
  }

  // Si el archivo está presente
  if (archivo) {
    const tipo_imagen = archivo.mimetype;

    // Leer la imagen como un buffer (binarios)
    const imagen_binaria = fs.readFileSync(archivo.path);

    try {
      // Inserta el libro en la base de datos con la imagen en formato binario
      const query = `
        INSERT INTO libros1 (nombre, categoria, imagen, tipo_imagen, archivo)
        VALUES ($1, $2, $3, $4, $5) 
        RETURNING id
      `;

      // Realizar la consulta de inserción con los datos binarios
      const result = await pool.query(query, [
        nombre,
        categoria,
        imagen_binaria, // Almacenar la imagen binaria en el campo "imagen"
        tipo_imagen, // Guardar el tipo de la imagen (MIME)
        enlace, // El enlace del libro
      ]);

      // Respuesta de éxito
      res.status(201).json({
        message: "Libro subido exitosamente con imagen binaria!",
        libroId: result.rows[0].id,
      });
    } catch (error) {
      console.error("Error al intentar subir el libro:", error.message);
      res.status(500).json({
        error: "Error subiendo el libro.",
        details: error.message || error,
      });
    } finally {
      // Eliminar el archivo físico después de leerlo para evitar dejar archivos temporales
      fs.unlinkSync(archivo.path);
    }
  } else {
    res.status(400).json({ error: "No se cargó ninguna imagen." });
  }
});
// Middleware para manejar errores
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Algo salió mal!');
});

// Inicializar el servidor en el puerto 3000
app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
